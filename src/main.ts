/**
 * Postman Collection Importer Extension
 *
 * Enables importing Postman collections (v2.1) and converting them to Voiden .void request files.
 *
 * Features:
 * - Import Postman collections from JSON files
 * - Automatic conversion to Voiden's .void format
 * - Preserves folder structure from collections
 * - Supports headers, request bodies, and query parameters
 * - Progress tracking during import
 *
 * When enabled, this extension adds an import button when viewing .json files
 * that contain Postman collections.
 */

import { PluginContext } from '@voiden/sdk/ui';
import React from 'react';
import { PostmanImportButton } from './components/PostmanImportButton';

const postmanImportPlugin = (context: PluginContext) => {
  const showToast = (context as any)?.ui?.showToast as
    | ((message: string, type?: 'info' | 'success' | 'warning' | 'error') => void)
    | undefined;

  return {
    onload: () => {
      // Register the import button as an editor action
      // Note: The component will use context.helpers.from('voiden-wrapper-api-extension')
      context.registerEditorAction({
        id: 'postman-import-button',
        component: (props: any) =>
          React.createElement(PostmanImportButton, {
            ...props,
            showToast,
          }),
        predicate: (tab) => {
          // Only show for .json files. Postman's actual format markers —
          // "schema.getpostman.com" (collection, in the top-level "info"
          // block) or "_postman_variable_scope" (environment export) — are
          // what we check for, not a bare "postman" substring: a loose word
          // match false-positives on any non-Postman collection that simply
          // hits postman-echo.com (Postman's own public test API, commonly
          // used from Insomnia/Bruno collections too) or otherwise mentions
          // the word anywhere in a URL, description, or name. Sniffing a
          // bounded prefix keeps the cost independent of file size instead
          // of rescanning the full (potentially multi-hundred-KB) buffer on
          // every render.
          if (!tab.title?.endsWith('.json')) return false;
          const c = (tab.content ?? '').slice(0, 65536);
          return c.includes('schema.getpostman.com') || c.includes('_postman_variable_scope');
        },
      });

    },
    onunload: () => {
    },
  };
};

export default postmanImportPlugin;
