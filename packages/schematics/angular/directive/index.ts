/**
 * @license
 * Copyright Google LLC All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.io/license
 */

import {
  Rule,
  SchematicsException,
  Tree,
  apply,
  applyTemplates,
  chain,
  filter,
  mergeWith,
  move,
  noop,
  strings,
  url
} from '@angular-devkit/schematics';
import { addDeclarationToNgModule } from '../utility/add-declaration-to-ng-module';
import { findModuleFromOptions } from '../utility/find-module';
import { parseName } from '../utility/parse-name';
import { validateHtmlSelector } from '../utility/validation';
import { buildDefaultPath, getWorkspace } from '../utility/workspace';
import { Schema as DirectiveOptions } from './schema';
import * as ts from '../third_party/github.com/Microsoft/TypeScript/lib/typescript';
import { getDecoratorMetadata } from '../utility/ast-utils';
import { getAppModulePath } from '../utility/ng-ast-utils';
import { InsertChange } from '../utility/change';

function buildSelector(options: DirectiveOptions, projectPrefix: string) {
  let selector = options.name;
  if (options.prefix) {
    selector = `${options.prefix}-${selector}`;
  } else if (options.prefix === undefined && projectPrefix) {
    selector = `${projectPrefix}-${selector}`;
  }

  return strings.camelize(selector);
}

function addDirectiveToComponentDecorator(tree: Tree, classifiedName: string, directivePath: string, componentPath: string): InsertChange[] {
  const text = tree.read(componentPath);
  if (text === null) {
    throw new SchematicsException(`Component file ${componentPath} not found.`);
  }

  const sourceText = text.toString('utf-8');
  const source = ts.createSourceFile(componentPath, sourceText, ts.ScriptTarget.Latest, true);

  // Recherchez les métadonnées du décorateur @Component
  const metadataNode: any = getDecoratorMetadata(source, 'Component', '@angular/core')
    .find(node => ts.isObjectLiteralExpression(node) && node.properties.length > 0);


  if (!metadataNode) {
    throw new SchematicsException(`Decorator @Component not found in ${componentPath}.`);
  }

  // metaData est un tableau de CallExpression où le premier argument devrait être un ObjectLiteralExpression
  const objectLiteral = metadataNode[0].arguments[0];
  if (!objectLiteral || !ts.isObjectLiteralExpression(objectLiteral)) {
    throw new SchematicsException(`Invalid @Component decorator content found in file ${componentPath}.`);
  }

  // Trouvez la propriété `imports`
  const importsProperty = metadataNode.properties
    .filter((prop: any) => ts.isPropertyAssignment(prop) && ts.isIdentifier(prop.name))
    .find((prop: any) => prop.name.text === 'imports') as ts.PropertyAssignment | undefined;

  // Déterminez où insérer la directive
  let insertPosition;
  if (importsProperty && importsProperty.initializer && ts.isArrayLiteralExpression(importsProperty.initializer)) {
    // Il y a déjà une propriété `imports`, donc nous ajoutons notre directive à celle-ci
    insertPosition = importsProperty.initializer.elements.end;
  } else {
    throw new SchematicsException(`Property 'imports' not found in the decorator @Component in ${componentPath}.`);
  }

  const change = new InsertChange(componentPath, insertPosition, `[${classifiedName}]`);
  return [change];
}

function addDirectiveToAppComponent(appComponentPath: string): Rule {
  return (tree: Tree) => {
    const changes = addDirectiveToComponentDecorator(
      tree,
      '${strings.classify(options.name)}Directive', /* Nom classé de la directive */
      './${strings.dasherize(options.name)}.directive', /* Chemin relatif */
      appComponentPath /* Chemin vers votre AppComponent */
    );

    // Appliquer les changements en utilisant un Tree Recorder
    const recorder = tree.beginUpdate(appComponentPath);
    changes.forEach(change => {
      if (change instanceof InsertChange) {
        recorder.insertLeft(change.pos, change.toAdd);
      }
    });
    tree.commitUpdate(recorder);

    return tree;
  };
}


export default function (options: DirectiveOptions): Rule {
  return async (host: Tree) => {
    const workspace = await getWorkspace(host);

    const project = workspace.projects.get(options.project as string);
    if (!project) {
      throw new SchematicsException(`Project "${options.project}" does not exist.`);
    }

    if (options.path === undefined) {
      options.path = buildDefaultPath(project);
    }

    options.module = findModuleFromOptions(host, options);

    const parsedPath = parseName(options.path, options.name);
    options.name = parsedPath.name;
    options.path = parsedPath.path;
    options.selector = options.selector || buildSelector(options, project.prefix || '');

    validateHtmlSelector(options.selector);

    const templateSource = apply(url('./files'), [
      options.skipTests ? filter((path) => !path.endsWith('.spec.ts.template')) : noop(),
      applyTemplates({
        ...strings,
        'if-flat': (s: string) => (options.flat ? '' : s),
        ...options,
      }),
      move(parsedPath.path),
    ]);

    return chain([
      addDeclarationToNgModule({
        type: 'directive',

        ...options,
      }),
      addDirectiveToAppComponent(getAppModulePath(host, options.module as string)),
      mergeWith(templateSource),
    ]);
  };
}
