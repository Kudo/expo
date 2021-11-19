import assert from 'assert';
import fs from 'fs-extra';
import path from 'path';

import { podInstallAsync } from '../CocoaPods';
import { getExpoRepositoryRootDir } from '../Directories';
import logger from '../Logger';
import { Package } from '../Packages';
import * as XcodeGen from './XcodeGen';
import { ProjectSpec } from './XcodeGen.types';
import XcodeProject, {
  flavorToFrameworkPath,
  spreadArgs,
  SHARED_DERIVED_DATA_DIR,
} from './XcodeProject';
import { Flavor, Framework, XcodebuildSettings } from './XcodeProject.types';

const MODULEMAP_FILE = 'ExpoModulesCore.modulemap';
const UMBRELLA_HEADER = 'ExpoModulesCore-umbrella.h';
const GENERATED_SWIFT_HEADER = 'ExpoModulesCore-Swift.h';

export function isExpoModulesCore(pkg: Package) {
  return pkg.packageName === 'expo-modules-core';
}

export async function generateXcodeProjectAsync(dir: string, spec: ProjectSpec): Promise<string> {
  await createModulemapAsync(dir);
  await createGeneratedHeaderAsync(dir);

  if (spec.settings?.base) {
    spec.settings.base['MODULEMAP_FILE'] = MODULEMAP_FILE;
    spec.settings.base['BUILD_LIBRARY_FOR_DISTRIBUTION'] = 'YES';
  }
  spec.targets?.[spec.name].sources?.[0].includes?.push(UMBRELLA_HEADER);

  const result = await XcodeGen.generateXcodeProjectAsync(dir, spec);

  logger.log('   Installing Pods');
  await createPodfileAsync(dir);
  await podInstallAsync(dir);
  await patchReactCoreModulemapAsync(dir);

  return result;
}

export async function buildFrameworkAsync(
  xcodeProject: XcodeProject,
  target: string,
  flavor: Flavor,
  options?: XcodebuildSettings
): Promise<Framework> {
  await buildWithRetriesAsync(xcodeProject.rootDir, async () => {
    await xcodeProject.xcodebuildAsync(
      [
        'build',
        '-workspace',
        `${xcodeProject.name}.xcworkspace`,
        '-scheme',
        `${target}_iOS`,
        '-configuration',
        flavor.configuration,
        '-sdk',
        flavor.sdk,
        ...spreadArgs('-arch', flavor.archs),
        '-derivedDataPath',
        SHARED_DERIVED_DATA_DIR,
      ],
      options
    );
  });

  const frameworkPath = flavorToFrameworkPath(target, flavor);
  const stat = await fs.lstat(path.join(frameworkPath, target));

  // Remove `Headers` as each our module contains headers as part of the provided source code
  // and CocoaPods exposes them through HEADER_SEARCH_PATHS either way.
  // await fs.remove(path.join(frameworkPath, 'Headers'));

  // `_CodeSignature` is apparently generated only for simulator, afaik we don't need it.
  await fs.remove(path.join(frameworkPath, '_CodeSignature'));

  return {
    target,
    flavor,
    frameworkPath,
    binarySize: stat.size,
  };
}

export async function cleanTemporaryFilesAsync(xcodeProject: XcodeProject) {
  const pathsToRemove = [
    `${xcodeProject.name}.xcworkspace`,
    'Pods',
    'Podfile',
    'Podfile.lock',
    MODULEMAP_FILE,
    UMBRELLA_HEADER,
    GENERATED_SWIFT_HEADER,
  ];
  await Promise.all(
    pathsToRemove.map((pathToRemove) => fs.remove(path.join(xcodeProject.rootDir, pathToRemove)))
  );
}

async function patchReactCoreModulemapAsync(workDir: string) {
  const modulemapPath = path.join(
    workDir,
    'Pods',
    'Headers',
    'Public',
    'React',
    'React-Core.modulemap'
  );

  assert(await fs.pathExists(modulemapPath), 'Cannot find the React-Core modulemap');

  let content = await fs.readFile(modulemapPath, 'utf-8');
  content = content.replace(
    'umbrella header "React-Core-umbrella.h"',
    'umbrella "../React-Core/React"'
  );

  await fs.writeFile(modulemapPath, content);
}

async function createPodfileAsync(workDir: string) {
  const content = `\
platform :ios, '12.0'

react_native_dir = File.dirname(\`node --print "require.resolve('react-native/package.json')"\`)
require File.join(react_native_dir, "scripts/react_native_pods")

target 'ExpoModulesCore_iOS' do
  use_react_native!(
    :path => react_native_dir
  )
end`;

  await fs.writeFile(path.join(workDir, 'Podfile'), content);
}

async function createModulemapAsync(workDir: string) {
  const content = `\
framework module ExpoModulesCore {
  umbrella header "ExpoModulesCore.h"

  export *
  module * { export * }
}`;
  await fs.writeFile(path.join(workDir, MODULEMAP_FILE), content);
}

async function createGeneratedHeaderAsync(workDir: string) {
  const srcUmbrellaHeader = path.join(
    getExpoRepositoryRootDir(),
    'apps/bare-expo/ios/Pods/Target Support Files/ExpoModulesCore/ExpoModulesCore-umbrella.h'
  );
  assert(
    await fs.pathExists(srcUmbrellaHeader),
    'Cannot find ExpoModulesCore-umbrella.h. Make sure to run `et pods -f` before this.'
  );

  let content = await fs.readFile(srcUmbrellaHeader, 'utf-8');
  content = content.replace(/^#import "ExpoModulesCore\//gm, '#import "');

  await fs.writeFile(path.join(workDir, UMBRELLA_HEADER), content);
}

async function buildWithRetriesAsync(
  workDir: string,
  builder: () => Promise<void>,
  retriesLimit: number = 4
) {
  let retries = 0;
  let undo = false;
  while (retries++ < retriesLimit) {
    try {
      await builder();
      break;
    } catch {
      logger.warn(
        `   There're building errors. Will retry again with patch - retries[${retries}] undo[${undo}]`
      );
      await patchFileImportAsync(workDir, undo);
      undo = !undo;
      await delayAsync(3000);
    }
  }

  if (retries >= retriesLimit) {
    throw new Error(
      `Exceeded retried build limit - SHARED_DERIVED_DATA_DIR[${SHARED_DERIVED_DATA_DIR}]`
    );
  }
}

async function delayAsync(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(() => {
      resolve();
    }, ms);
  });
}

async function patchFileImportAsync(workDir: string, undo: boolean) {
  const file = path.join(workDir, 'EXBridgeModule.h');
  assert(await fs.pathExists(file));
  let content = await fs.readFile(file, 'utf-8');

  const anchor = '#import <React/RCTBridgeModule.h>';
  const newImport = '@import React.RCTBrdigeModule;';
  if (!undo) {
    content = content.replace(anchor, `${newImport}\n${anchor}`);
  } else {
    content = content.replace(`${newImport}\n${anchor}`, anchor);
  }
  await fs.writeFile(file, content);
}
