import { homedir } from 'node:os';
import { join } from 'node:path';

const JAM_COMMANDS = [
  'ask',
  'chat',
  'run',
  'explain',
  'search',
  'diff',
  'patch',
  'auth',
  'config',
  'models',
  'history',
  'completion',
  'doctor',
];

function generateBashCompletion(): string {
  const commandList = JAM_COMMANDS.join(' ');
  // Use array join to avoid template literal issues with bash ${VAR} syntax
  return [
    '# Bash completion for jam',
    '# Add this to your ~/.bashrc or source it directly.',
    '',
    '_jam_completions() {',
    '  local cur prev words cword',
    '  _init_completion 2>/dev/null || {',
    '    COMPREPLY=()',
    '    cur="${COMP_WORDS[COMP_CWORD]}"',
    '    prev="${COMP_WORDS[COMP_CWORD-1]}"',
    '  }',
    '',
    `  local commands="${commandList}"`,
    '',
    '  case "${prev}" in',
    '    jam)',
    '      COMPREPLY=( $(compgen -W "${commands}" -- "${cur}") )',
    '      return 0',
    '      ;;',
    '    auth)',
    '      COMPREPLY=( $(compgen -W "login logout" -- "${cur}") )',
    '      return 0',
    '      ;;',
    '    config)',
    '      COMPREPLY=( $(compgen -W "show init" -- "${cur}") )',
    '      return 0',
    '      ;;',
    '    models)',
    '      COMPREPLY=( $(compgen -W "list" -- "${cur}") )',
    '      return 0',
    '      ;;',
    '    history)',
    '      COMPREPLY=( $(compgen -W "list show" -- "${cur}") )',
    '      return 0',
    '      ;;',
    '    completion)',
    '      COMPREPLY=( $(compgen -W "install" -- "${cur}") )',
    '      return 0',
    '      ;;',
    '  esac',
    '',
    '  COMPREPLY=( $(compgen -W "${commands}" -- "${cur}") )',
    '  return 0',
    '}',
    '',
    'complete -F _jam_completions jam',
  ].join('\n');
}

function generateZshCompletion(): string {
  const commandDefs = JAM_COMMANDS.map((cmd) => `    '${cmd}'`).join('\n');
  return [
    '#compdef jam',
    '# Zsh completion for jam',
    '# Add this file to a directory in your $fpath, or source it in ~/.zshrc.',
    '',
    '_jam() {',
    '  local -a commands',
    '  commands=(',
    commandDefs,
    '  )',
    '',
    '  local -a auth_cmds config_cmds models_cmds history_cmds completion_cmds',
    "  auth_cmds=('login' 'logout')",
    "  config_cmds=('show' 'init')",
    "  models_cmds=('list')",
    "  history_cmds=('list' 'show')",
    "  completion_cmds=('install')",
    '',
    '  case "$words[1]" in',
    '    auth)',
    "      _describe 'auth subcommands' auth_cmds",
    '      ;;',
    '    config)',
    "      _describe 'config subcommands' config_cmds",
    '      ;;',
    '    models)',
    "      _describe 'models subcommands' models_cmds",
    '      ;;',
    '    history)',
    "      _describe 'history subcommands' history_cmds",
    '      ;;',
    '    completion)',
    "      _describe 'completion subcommands' completion_cmds",
    '      ;;',
    '    *)',
    "      _describe 'jam commands' commands",
    '      ;;',
    '  esac',
    '}',
    '',
    '_jam "$@"',
  ].join('\n');
}

function detectShell(): string {
  const shellEnv = process.env['SHELL'] ?? '';
  if (shellEnv.includes('zsh')) return 'zsh';
  if (shellEnv.includes('bash')) return 'bash';
  return 'bash';
}

export function runCompletionInstall(options: { shell?: string }): void {
  const shell = options.shell ?? detectShell();
  const home = homedir();

  if (shell === 'zsh') {
    const script = generateZshCompletion();
    const completionFile = join(home, '.config', 'jam', 'completions', '_jam');
    const rcFile = join(home, '.zshrc');

    process.stdout.write('Zsh completion script for jam:\n\n');
    process.stdout.write(script + '\n\n');
    process.stdout.write('To install:\n\n');
    process.stdout.write(`  mkdir -p ${join(home, '.config', 'jam', 'completions')}\n`);
    process.stdout.write(`  jam completion install --shell zsh > ${completionFile}\n`);
    process.stdout.write(`  echo 'fpath=(${join(home, '.config', 'jam', 'completions')} $fpath)' >> ${rcFile}\n`);
    process.stdout.write(`  echo 'autoload -Uz compinit && compinit' >> ${rcFile}\n`);
    process.stdout.write(`  source ${rcFile}\n`);
  } else if (shell === 'bash') {
    const script = generateBashCompletion();
    const completionFile = join(home, '.config', 'jam', 'completions', 'jam.bash');
    const rcFile = join(home, '.bashrc');

    process.stdout.write('Bash completion script for jam:\n\n');
    process.stdout.write(script + '\n\n');
    process.stdout.write('To install:\n\n');
    process.stdout.write(`  mkdir -p ${join(home, '.config', 'jam', 'completions')}\n`);
    process.stdout.write(`  jam completion install --shell bash > ${completionFile}\n`);
    process.stdout.write(`  echo 'source ${completionFile}' >> ${rcFile}\n`);
    process.stdout.write(`  source ${rcFile}\n`);
  } else {
    process.stderr.write(
      `Unsupported shell: "${shell}". Supported: bash, zsh.\n` +
        `Use --shell bash or --shell zsh.\n`
    );
    process.exit(1);
  }
}
