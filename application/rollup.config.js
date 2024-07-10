import svelte from 'rollup-plugin-svelte';
import commonjs from '@rollup/plugin-commonjs';
import resolve from '@rollup/plugin-node-resolve';
import replace from '@rollup/plugin-replace';
import livereload from 'rollup-plugin-livereload';
import { terser } from 'rollup-plugin-terser';
import css from 'rollup-plugin-css-only';
import postcss from 'rollup-plugin-postcss';
import typescript from '@rollup/plugin-typescript';
import { sveltePreprocess } from 'svelte-preprocess'

const production = !process.env.ROLLUP_WATCH;

function serve() {
	let server;

	function toExit() {
		if (server) server.kill(0);
	}

	return {
		writeBundle() {
			if (server) return;
			server = require('child_process').spawn('npm', ['run', 'start', '--', '--dev'], {
				stdio: ['ignore', 'inherit', 'inherit'],
				shell: true
			});

			process.on('SIGTERM', toExit);
			process.on('exit', toExit);
		}
	};
}

export default {
	input: 'src/frontend/main.ts',
	output: {
		sourcemap: true,
		format: 'iife',
		name: 'app',
		file: 'public/build/bundle.js',
	},
	plugins: [
		postcss({
      plugins: [
        require('tailwindcss'),
        require('autoprefixer'),
      ],
      extract: true, // Extract CSS to a file
      minimize: production, // Minify CSS in production
    }),
		svelte({
			preprocess: sveltePreprocess({ postcss: true, sourceMap: !production }),
			compilerOptions: {
        dev: !production
      },
    }),
		commonjs({
			include: ['node_modules/**', '../packages/ogi-addon/**', '../packages/real-debrid/**']
		}),
		typescript({ sourceMap: !production, inlineSources: !production }),

		// we'll extract any component CSS out into
		// a separate file - better for performance
		css({ output: 'bundle.css' }),

		// If you have external dependencies installed from
		// npm, you'll most likely need these plugins. In
		// some cases you'll need additional configuration -
		// consult the documentation for details:
		// https://github.com/rollup/plugins/tree/master/packages/commonjs
		// replace the ogi-addon resolutions to the local package
		// replace({
		// 	'ogi-addon': '../packages/ogi-addon',
		// }),
		
		resolve({
			browser: true,
			modulePaths: ['node_modules'],
			dedupe: ['svelte', 'ogi-addon']
		}),

		// In dev mode, call `npm run start` once
		// the bundle has been generated
		!production && serve(),

		// Watch the `public` directory and refresh the
		// browser on changes when not in production
		!production && livereload('public'),

		// If we're building for production (npm run build
		// instead of npm run dev), minify
		production && terser()
	],
	watch: {
		clearScreen: false
	}
};
