/* eslint-disable no-console */
/**
 * Transpiles TypeScript demos to formatted JavaScript.
 * Can be used to verify that JS and TS demos are equivalent. No introduced change
 * would indicate equivalence.
 */

/**
 * List of demos to ignore when transpiling
 * Example: "app-bar/BottomAppBar.tsx"
 */
const ignoreList = ['/pages.ts'];

const fse = require('fs-extra');
const path = require('path');
const babel = require('@babel/core');
const prettier = require('prettier');
const typescriptToProptypes = require('typescript-to-proptypes');
const yargs = require('yargs');
const { fixBabelGeneratorIssues, fixLineEndings } = require('./helpers');

const tsConfig = typescriptToProptypes.loadConfig(path.resolve(__dirname, '../tsconfig.json'));

const babelConfig = {
  presets: ['@babel/preset-typescript'],
  plugins: [],
  generatorOpts: { retainLines: true },
  babelrc: false,
  configFile: false,
};

const workspaceRoot = path.join(__dirname, '../../');

async function getFiles(root) {
  const files = [];

  try {
    await Promise.all(
      (
        await fse.readdir(root)
      ).map(async (name) => {
        const filePath = path.join(root, name);
        const stat = await fse.stat(filePath);

        if (stat.isDirectory()) {
          files.push(...(await getFiles(filePath)));
        } else if (
          stat.isFile() &&
          filePath.endsWith('.tsx') &&
          !ignoreList.some((ignorePath) => filePath.endsWith(path.normalize(ignorePath)))
        ) {
          files.push(filePath);
        }
      }),
    );
  } catch (error) {
    if (error.message?.includes('no such file or directory')) {
      return [];
    }
    throw error;
  }

  return files;
}

const TranspileResult = {
  Success: 0,
  Skipped: 1,
  Failed: 2,
};

async function transpileFile(tsxPath, program, ignoreCache = false) {
  const jsPath = tsxPath.replace('.tsx', '.js');
  try {
    if (!ignoreCache && (await fse.exists(jsPath))) {
      const [jsStat, tsxStat] = await Promise.all([fse.stat(jsPath), fse.stat(tsxPath)]);
      if (jsStat.mtimeMs > tsxStat.mtimeMs) {
        // JavaScript version is newer, skip transpiling
        return TranspileResult.Skipped;
      }
    }

    const source = await fse.readFile(tsxPath, 'utf8');

    const transformOptions = { ...babelConfig, filename: tsxPath };
    const enableJSXPreview = !tsxPath.includes(path.join('pages', 'premium-themes'));
    if (enableJSXPreview) {
      transformOptions.plugins = transformOptions.plugins.concat([
        [
          require.resolve('docsx/src/modules/utils/babel-plugin-jsx-preview'),
          { maxLines: 16, outputFilename: `${tsxPath}.preview` },
        ],
      ]);
    }
    const { code } = await babel.transformAsync(source, transformOptions);

    if (/import \w* from 'prop-types'/.test(code)) {
      throw new Error('TypeScript demo contains prop-types, please remove them');
    }

    const propTypesAST = typescriptToProptypes.parseFromProgram(tsxPath, program, {
      shouldResolveObject: ({ name }) => {
        const propsToNotResolve = [
          'classes',
          'state',
          'currentColumn',
          'colDef',
          'row',
          'selectedDay',
          'day',
          'defaultValue',
          'value',
        ];
        if (propsToNotResolve.includes(name)) {
          return false;
        }
        return undefined;
      },
    });
    const codeWithPropTypes = typescriptToProptypes.inject(propTypesAST, code);

    const prettierConfig = prettier.resolveConfig.sync(jsPath, {
      config: path.join(workspaceRoot, 'prettier.config.js'),
    });
    const prettierFormat = (jsSource) =>
      prettier.format(jsSource, { ...prettierConfig, filepath: jsPath });

    const prettified = prettierFormat(codeWithPropTypes);
    const formatted = fixBabelGeneratorIssues(prettified);
    const correctedLineEndings = fixLineEndings(source, formatted);

    // removed blank lines change potential formatting
    await fse.writeFile(jsPath, prettierFormat(correctedLineEndings));
    return TranspileResult.Success;
  } catch (err) {
    console.error('Something went wrong transpiling %s\n%s\n', tsxPath, err);
    return TranspileResult.Failed;
  }
}

async function main(argv) {
  const { watch: watchMode, disableCache: cacheDisabled } = argv;

  const tsxFiles = [
    ...(await getFiles(path.join(workspaceRoot, 'docs/src/pages'))), // old structure
    ...(await getFiles(path.join(workspaceRoot, 'docs/data'))), // new structure
  ];

  const program = typescriptToProptypes.createProgram(tsxFiles, tsConfig);

  let successful = 0;
  let failed = 0;
  let skipped = 0;
  (await Promise.all(tsxFiles.map((file) => transpileFile(file, program, cacheDisabled)))).forEach(
    (result) => {
      switch (result) {
        case TranspileResult.Success: {
          successful += 1;
          break;
        }
        case TranspileResult.Failed: {
          failed += 1;
          break;
        }
        case TranspileResult.Skipped: {
          skipped += 1;
          break;
        }
        default: {
          throw new Error(`No handler for ${result}`);
        }
      }
    },
  );

  console.log(
    [
      '------ Summary ------',
      '%i demo(s) were successfully transpiled',
      '%i demo(s) were skipped',
      '%i demo(s) were unsuccessful',
    ].join('\n'),
    successful,
    skipped,
    failed,
  );

  if (!watchMode) {
    if (failed > 0) {
      process.exit(1);
    }
    return;
  }

  tsxFiles.forEach((filePath) => {
    fse.watchFile(filePath, { interval: 500 }, async () => {
      if ((await transpileFile(filePath, program, true)) === 0) {
        console.log('Success - %s', filePath);
      }
    });
  });

  console.log('\nWatching for file changes...');
}

yargs
  .command({
    command: '$0',
    description: 'transpile TypeScript demos',
    builder: (command) => {
      return command
        .option('watch', {
          default: false,
          description: 'transpiles demos as soon as they changed',
          type: 'boolean',
        })
        .option('disable-cache', {
          default: false,
          description: 'transpiles all demos even if they didnt change',
          type: 'boolean',
        });
    },
    handler: main,
  })
  .help()
  .strict(true)
  .version(false)
  .parse();
