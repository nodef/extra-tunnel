import {parseArgs}  from "@std/cli/parse-args";


// Run a command in a subprocess, with inherited stdio.
async function run(command: string, args: string[], cwd?: string) {
  const cmd = new Deno.Command(command, {
    args: args,
    cwd:  cwd,
    stdin:  'inherit',
    stdout: 'inherit',
    stderr: 'inherit'
  });
  return await cmd.spawn().status;
}


// Publish core package to npm.
async function publishCoreToNpm(name: string) {
  const file = name.replace(/\//g, '__');
  console.log(`Publishing the ${name} package to npm...`);
  await run('deno', ['pack', '--output', `${file}.tgz`, '--allow-dirty']);
  Deno.mkdirSync('.temp-pack', {recursive: true});
  await run('tar', ['-xzf', `${file}.tgz`, '-C', '.temp-pack']);
  Deno.removeSync(`${file}.tgz`);
  const meta = JSON.parse(await Deno.readTextFile('.temp-pack/package/package.json'));
  meta.name = name;
  // meta.bin  = {"sleep": "bin.js"};
  await Deno.writeTextFile('.temp-pack/package/package.json', JSON.stringify(meta, null, 2));
  await run('npm', ['publish', '--access', 'public'], '.temp-pack/package');
  await Deno.remove('.temp-pack', {recursive: true});
}


// Main function, of course.
async function main() {
  const meta = JSON.parse(await Deno.readTextFile('deno.json'));
  const name = meta.name.replace(/^@nodef\//, '');
  const args = parseArgs(Deno.args, {
    boolean: ['publish-core'],
    default: {'publish-core': false}
  });
  if (args['publish-core']) {
    await publishCoreToNpm(name);
    await publishCoreToNpm(`@nodef/${name}`);
  }
}
main();
