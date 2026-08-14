# BOBOCLOUD UI language packs

Language packs are data-only plugins. A pack is a directory containing exactly the
two files below; JavaScript, native modules, and executable hooks are never loaded.

```text
my-locale/
  manifest.json
  messages.json
```

## Manifest

```json
{
  "schemaVersion": 1,
  "id": "fr",
  "name": "French",
  "nativeName": "Francais",
  "locale": "fr",
  "version": "1.0.0",
  "direction": "ltr",
  "monacoLocale": "fr",
  "fallback": "en"
}
```

- `schemaVersion` must be `1`.
- `id` must match the directory name after installation.
- `direction` is either `ltr` or `rtl`.
- `monacoLocale` may be empty when Monaco should use its default strings.
- `fallback` is another installed pack ID. Cycles are safely ignored.

## Messages

`messages.json` is a flat JSON object. Keys are the English source strings used by
the application and values are their translations. Placeholders such as `{name}`,
`{count}`, and `{message}` must be retained.

```json
{
  "Settings": "Parametres",
  "Remove {name}": "Supprimer {name}"
}
```

Translation values are inserted through text DOM APIs. HTML in a translation is
displayed as text and is never executed.

## Install and hot reload

Choose **Settings > Language > Install pack** and select the pack directory. The
validated JSON files are copied to the app's user-data `language-packs` directory.
Use **Open folder** to edit installed packs. File changes are watched and the active
application chrome reloads the pack without restarting the app.

Monaco's own built-in menus load their locale at editor startup. When a pack changes
`monacoLocale`, reload the editor window once; the rest of the UI switches live.

The loader limits manifest and message size, rejects invalid identifiers, symbolic
links, non-string messages, unsupported schemas, and paths outside the user pack
directory. User-installed packs may override a built-in pack with the same ID;
removing the override restores the built-in pack.
