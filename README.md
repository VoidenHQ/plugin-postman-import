> A plugin for [Voiden](https://github.com/VoidenHQ) — the developer-first API client.

# Postman Collection Importer

Migrate from Postman by importing v2.1 collections — folder structure, headers, auth, environment variables, and all body types are preserved.

## Features

- Import Postman Collection v2.1 JSON files
- Automatically creates folder structure matching the collection hierarchy
- Converts each request to a native `.void` file
- Supports all HTTP methods
- Imports headers and converts them to headers-table blocks
- Imports query parameters and converts them to query-table blocks
- Imports JSON bodies, form-data, and URL-encoded bodies
- Converts Postman's raw mode to the appropriate body type
- Sanitizes file and folder names for filesystem compatibility
- Nested folder support (unlimited depth)

## Usage

Click the **Import Postman** button in the left sidebar, select a Postman v2.1 `.json` export file, and the importer will recreate your collection as a Voiden folder tree.
