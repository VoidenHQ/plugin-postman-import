import { useState, useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { importPostmanCollection } from "../utils/converter";
import { isPostmanEnvironmentExport } from "../utils/types";
import { Check, X, XCircle } from "lucide-react";

const COMPLETED_DISPLAY_MS = 2000;

/**
 * Best-effort detection of whether content is a Postman environment/globals
 * export, used purely to pick the right button copy.
 *
 * Avoids JSON.parse on potentially large (900 KB+) files — the distinguishing
 * field "_postman_variable_scope" always appears near the top of an env export
 * and never in a collection, so a cheap string probe is sufficient.
 */
function looksLikeEnvironmentExport(content: string): boolean {
  if (!content) return false;
  const marker = '"_postman_variable_scope"';
  const idx = content.indexOf(marker);
  if (idx === -1 || idx > 2000) return false;
  const after = content.slice(idx + marker.length).trimStart();
  return after.startsWith(':"environment"') || after.startsWith(': "environment"') ||
         after.startsWith(':"globals"') || after.startsWith(': "globals"');
}

interface PostmanImportButtonProps {
  tab: {
    tabId: string;
    title: string;
    content: string;
    type: string;
    source?: string;
  };
  showToast?: (message: string, type?: 'info' | 'success' | 'warning' | 'error') => void;
}

// Persist import state across tab switches — component remounts when switching tabs
// but the async import continues, so we need to restore progress on remount.
interface ImportState {
  isImporting: boolean;
  progress: { current: number; total: number };
  error: string | null;
  successMessage: string | null;
}
const importStateCache = new Map<string, ImportState>();
// Module-level cancel signals keyed by tabId so cancel survives remount too
const cancelSignals = new Map<string, { cancelled: boolean }>();

export const PostmanImportButton = ({ tab, showToast }: PostmanImportButtonProps) => {
  const cached = importStateCache.get(tab.tabId);
  const [progress, setProgress] = useState(cached?.progress ?? { current: 0, total: 0 });
  const [isImporting, setIsImporting] = useState(cached?.isImporting ?? false);
  const [error, setError] = useState<string | null>(cached?.error ?? null);
  const [isErrorVisible, setIsErrorVisible] = useState(false);
  const [successMessage, setSuccessMessage] = useState<string | null>(cached?.successMessage ?? null);
  const [isEnvironment, setIsEnvironment] = useState(() => looksLikeEnvironmentExport(tab.content));
  const cancelSignalRef = useRef<{ cancelled: boolean } | null>(null);
  const completedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Clear any pending "Completed" auto-reset timer on unmount
  useEffect(() => {
    return () => {
      if (completedTimerRef.current) clearTimeout(completedTimerRef.current);
    };
  }, []);

  // Keep cache in sync with state
  useEffect(() => {
    importStateCache.set(tab.tabId, { isImporting, progress, error, successMessage });
  }, [tab.tabId, isImporting, progress, error, successMessage]);

  // Re-check in case content streams in after mount (large files load tab.content lazily)
  useEffect(() => {
    if (tab.content) {
      setIsEnvironment(looksLikeEnvironmentExport(tab.content));
    }
  }, [tab.content]);

  const queryClient = useQueryClient();

  // Handle error visibility with fade animation
  useEffect(() => {
    if (error) {
      setIsErrorVisible(true);

      const hideTimer = setTimeout(() => {
        setIsErrorVisible(false);

        // Wait for fade out animation before clearing error
        const clearTimer = setTimeout(() => {
          setError(null);
        }, 300);

        return () => clearTimeout(clearTimer);
      }, 5000);

      return () => clearTimeout(hideTimer);
    }
  }, [error]);

  const handleCancel = () => {
    if (cancelSignalRef.current) {
      cancelSignalRef.current.cancelled = true;
    }
    setIsImporting(false);
    setProgress({ current: 0, total: 0 });
    importStateCache.delete(tab.tabId);
    cancelSignals.delete(tab.tabId);
  };

  const handleImport = async () => {
    if (completedTimerRef.current) {
      clearTimeout(completedTimerRef.current);
      completedTimerRef.current = null;
    }
    try {
      setError(null);
      setIsErrorVisible(false);
      setSuccessMessage(null);
      setIsImporting(true);
      setProgress({ current: 0, total: 0 });

      // Create a new cancel signal for this import run
      const signal = { cancelled: false };
      cancelSignalRef.current = signal;
      cancelSignals.set(tab.tabId, signal);

      // Get the active project from React Query cache
      const projects = queryClient.getQueryData<{
        projects: { path: string; name: string }[];
        activeProject: string;
      }>(["projects"]);

      const activeProject = projects?.activeProject;

      if (!activeProject) {
        setError("No active project found");
        setIsImporting(false);
        return;
      }

      // For streamable (large) files, tab.content is empty — read from disk instead.
      let content = tab.content;
      if ((!content || content.trim() === '') && tab.source) {
        content = await (window as any).electron?.files.read(tab.source) ?? '';
      }

      if (!content || content.trim() === '') {
        setError("Postman collection is empty");
        setIsImporting(false);
        return;
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(content);
      } catch {
        setError("Invalid JSON format");
        setIsImporting(false);
        return;
      }

      const isEnvImport = isPostmanEnvironmentExport(parsed);
      setIsEnvironment(isEnvImport);

      let finalTotal = 0;
      const result = await importPostmanCollection(content, activeProject, (current, total) => {
        finalTotal = total;
        setProgress({ current, total });
      }, (itemName, error) => {
        const message = error instanceof Error ? error.message : String(error);
        showToast?.(`Failed to import "${itemName}": ${message}`, 'error');
      }, signal);

      // If cancelled mid-way, don't show success state
      if (signal.cancelled) return;

      // Success — show a brief "Completed" state (no lingering colored button),
      // fire a toast with the details, then auto-reset after a couple seconds.
      const completedMessage = isEnvImport
        ? (result?.message ?? "Environment imported")
        : `Imported ${finalTotal} request${finalTotal === 1 ? "" : "s"}`;

      showToast?.(completedMessage, 'success');
      setSuccessMessage(completedMessage);
      setProgress({ current: 0, total: 0 });
      setIsImporting(false);

      completedTimerRef.current = setTimeout(() => {
        setSuccessMessage(null);
        importStateCache.delete(tab.tabId);
        cancelSignals.delete(tab.tabId);
      }, COMPLETED_DISPLAY_MS);

    } catch (error) {
      console.error("Failed to import Postman collection:", error);

      const errorMessage = error instanceof Error
        ? error.message
        : typeof error === 'string'
          ? error
          : 'Failed to import collection';

      setError(errorMessage);
      setProgress({ current: 0, total: 0 });
      setIsImporting(false);
    }
  };

  const dismissError = () => {
    setIsErrorVisible(false);
    setTimeout(() => setError(null), 300);
  };

  const getButtonText = () => {
    if (successMessage) return successMessage;

    if (isEnvironment) {
      return isImporting ? "Importing variables..." : "Import Environment Variables";
    }

    if (isImporting && progress.current > 0 && progress.current < progress.total) {
      return `Generating files... ${progress.current}/${progress.total}`;
    }

    return "Generate Voiden files";
  };

  const getButtonClass = () => {
    const baseClass = "px-2 py-0.5 rounded-sm text-sm transition-all duration-200 inline-flex items-center gap-1";

    if (successMessage) {
      return `${baseClass} bg-panel text-foreground`;
    }

    if (isImporting && (isEnvironment || (progress.current > 0 && progress.current < progress.total))) {
      return `${baseClass} bg-yellow-500 hover:bg-yellow-600 text-black cursor-wait`;
    }

    return `${baseClass} bg-panel hover:bg-active text-foreground`;
  };

  const isInProgress = isImporting && (isEnvironment || (progress.current > 0 && progress.current < progress.total));

  return (
    <div className="flex flex-col gap-1">
      {!error && (
        <div className="flex items-center gap-2">
          <button
            className={getButtonClass()}
            onClick={handleImport}
            disabled={isInProgress}
            title={isInProgress ? "Import in progress..." : isEnvironment ? "Import Postman environment variables" : "Import Postman collection"}
          >
            {successMessage && <Check size={14} />}
            {getButtonText()}
          </button>

          {/* Cancel button — only visible while import is running */}
          {isImporting && !isEnvironment && (
            <button
              onClick={handleCancel}
              title="Cancel"
              className="text-muted hover:text-red-500 transition-colors"
            >
              <XCircle size={15} />
            </button>
          )}

          {/* Progress percentage */}
          {!isEnvironment && isImporting && progress.current > 0 && progress.total > 0 && (
            <div className="text-xs text-gray-500">
              {Math.round((progress.current / progress.total) * 100)}%
            </div>
          )}
        </div>
      )}

      {/* Error message with fade animation */}
      {error && (
        <div className={`transition-all duration-300 overflow-hidden ${isErrorVisible ? 'max-h-20 opacity-100' : 'max-h-0 opacity-0'}`}>
          <div className="flex items-center justify-between border border-red-200 rounded px-2 py-1">
            <span className="text-red-600 dark:text-red-400 text-xs">
              {error}
            </span>
            <button
              onClick={dismissError}
              className="text-red-500 hover:text-red-700 text-xs ml-2"
              title="Dismiss error"
            >
              <X size={12} />
            </button>
          </div>
        </div>
      )}
    </div>
  );
};
