import { readFile } from 'node:fs/promises';
import { transform } from 'esbuild';
import { transformAsync } from '@babel/core';
import solid from 'babel-preset-solid';

export const solidPlugin = { name: 'solid', setup(build) {
  build.onLoad({ filter: /\.tsx$/ }, async ({ path }) => {
    const stripped = await transform(await readFile(path, 'utf8'), { loader: 'tsx', jsx: 'preserve', target: 'es2022' });
    const result = await transformAsync(stripped.code, { filename: path, configFile: false, babelrc: false, presets: [[solid, { generate: 'dom', hydratable: false }]] });
    return { contents: result.code, loader: 'js' };
  });
} };
