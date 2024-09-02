// @ts-check
import { input, select } from '@inquirer/prompts';
import { resolve } from 'path';
import fs from 'fs/promises';
import { existsSync } from 'fs';
import { exec, execSync } from 'child_process';
const addonName = await input({ message: 'What is the name of the addon?', required: true, default: '' });
const addonID = await input({ message: 'What is the ID of the addon?', required: true, default: addonName.replace(/\s/g, '-').toLowerCase() });
const author = await input({ message: 'Who is the author?', required: true });
const directory = await input({ message: 'Where should the addon be made?', required: true, default: './' + addonID });
const language = await select({ message: 'What language should the addon be made in?', 
  default: 'ts',
  choices: [
    { 
      name: 'JavaScript',
      value: 'js',
    },
    { 
      name: 'TypeScript (Recommended)',
      value: 'ts',
    },
  ] 
});

if (directory !== './' && directory !== '.') {
  await fs.mkdir(directory);
}

// then, get the template files from skeleton/{ts | js} and write them to the directory
const templateDir = `${import.meta.dirname}/skeleton/${language}`;
const files = await fs.readdir(templateDir);
console.log('🏗️ \x1b[1m\x1b[34mCreating addon in', resolve(directory), 'using', language + "\x1b[0m");

for (const file of files) {
  const contents = await fs.readFile(`${templateDir}/${file}`, 'utf-8');
  await fs.writeFile(`${directory}/${file}`, contents
    .replace(/{addon-name}/g, addonName)
    .replace(/{author}/g, author)
    .replace(/{addon-id}/g, addonID)
    .replace(/{path}/g, resolve(directory))
  );
}

process.chdir(directory);
console.log('📦 \x1b[1m\x1b[34mInstalling dependencies...\x1b[0m')
execSync('bun add ogi-addon@latest', { stdio: 'inherit' });
if (language === 'ts') execSync('bun add --dev typescript', { stdio: 'inherit' });
console.log('✨ \x1b[1m\x1b[34mYour addon has been created!\x1b[0m');
console.log('\x1b[1m\x1b[34mRead the README.md in your new addon for more information on how to get started.\x1b[0m');
process.exit(0);