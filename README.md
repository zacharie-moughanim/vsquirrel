# VSquirrel

VScod{e,ium} extension for Squirrel proof assistant

## Features

## Requirements

- [Squirrel proof assistant](https://github.com/squirrel-prover/squirrel-prover)
- A python interpreter

## Extension Settings

TODO (paths to squirrel and python)

## Known Issues

- When calling proof next when the dot is the last character of the file (without newline afterward), the highlighting persist on the whole file, even after modification. Plus, when writing from the end of a range, the range will update to keep being at the cursor.
- Squirrel has a HTML export, though not directly accessible via the CLI in interactive mode, whereas the extension transforms the prompt output of squirrel into HTML.
- Only one squirrel file can be supported at a time.

## Release Notes

### 0.0.1