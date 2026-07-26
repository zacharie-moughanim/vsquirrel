# VSquirrel

VScod{e,ium} extension for [Squirrel proof assistant](https://squirrel-prover.github.io/).

## Features

- Syntax highlighting for Squirrel (.sp) files;
- start and manage proofs on a given file (a proof can be started on several files at a time).

The extension bundles a [LSP server](https://github.com/zacharie-moughanim/pysquirrel-prover-lsp) to manage proofs via squirrel's interactive mode.

## Requirements

Once these are installed, [check here to set up the extension.](#extension-settings).

- Squirrel proof assistant follow the installation guide on [squirrel's repository](https://github.com/squirrel-prover/squirrel-prover/#readme).
- A python interpreter.

## Extension Settings

There are two settings necessary for the extension to work:
- the path to the compiled squirrel file;
- the path to a python interpreter.

## Known Issues

- Colors are hard-coded (with variant for dark/light theme).
- Only one command can be in processing at a time.
- Squirrel has a HTML export, though not directly accessible via the CLI in interactive mode, whereas the extension transforms the prompt output of squirrel into HTML.