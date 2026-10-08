import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');
const wrapper = read('../deploy/septa-bots');
const cli = read('../cli.js');

// The subcommands bot/cli.js runs, and the ones the installed `septa-bots`
// wrapper passes on to it (anything else prints its usage).
const cliCommands = [...cli.matchAll(/command === '(\w+)'/g)].map((m) => m[1]);
const forwarded = wrapper.match(/^ {2}(\w+(?: \| \w+)+)\)$/m)[1].split(' | ');
const usage = wrapper.split('set -euo pipefail')[0];

describe('the septa-bots operator command', () => {
  it('passes every cli.js subcommand on to it', () => {
    expect(cliCommands.length).toBeGreaterThan(5);
    expect(cliCommands.filter((c) => !forwarded.includes(c))).toEqual([]);
  });

  it('lists every subcommand in its usage text', () => {
    expect(cliCommands.filter((c) => !usage.includes(`sudo septa-bots ${c}`))).toEqual([]);
  });

  it('prints all of its usage text, not part of it', () => {
    const lines = usage.split('\n').length - 1; // minus the shebang's own line
    const range = wrapper.match(/sed -n '2,(\d+)p'/)[1];
    expect(Number(range)).toBeGreaterThanOrEqual(lines);
  });
});
