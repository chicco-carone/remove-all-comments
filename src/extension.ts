import * as vscode from "vscode";
import { excludePatterns } from "./excludePatterns";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

/**
 * Represents a file that has been modified by the extension.
 * Contains the original content and metadata about the modification.
 */
interface FileChange {
  originalContent: string;
  timestamp: number;
  fileName: string;
}

/**
 * Statistics about the comment removal process.
 * Tracks the number of files processed and comments removed.
 */
interface ProcessStats {
  processedFiles: number;
  removedCommentLines: number;
  skippedFiles: number;
}

/**
 * Result of removing comments from text.
 * Contains the modified text and count of removed comments.
 */
export interface RemoveCommentsResult {
  text: string;
  removedCount: number;
}

/**
 * Map to store recent file changes for potential restoration.
 * Keys are file paths, values are FileChange objects.
 */
const recentChanges = new Map<string, FileChange>();

/**
 * Removes single-line comments from text while preserving special comments.
 * Handles both JavaScript-style (//) and Python-style (#) comments.
 * Preserves comments that match patterns in excludePatterns.
 * Removes entire lines if they only contain comments (and whitespace).
 * Removes only the comment part for inline comments.
 *
 * @param text The source text to process
 * @returns Object containing processed text and number of comments removed/lines modified
 */
export function removeCommentsFromText(text: string): RemoveCommentsResult {
  const lines = text.split(/\r?\n/);
  let removedCount = 0;
  const finalFilteredLines: string[] = [];

  for (const line of lines) {
    if (!line.trim()) {
      finalFilteredLines.push(line);
      continue;
    }

    let inString = false;
    let stringChar = "";
    let commentStart = -1;

    for (let i = 0; i < line.length; i++) {
      const char = line[i];

      if ((char === '"' || char === "'") && (i === 0 || line[i - 1] !== "\\")) {
        if (!inString) {
          inString = true;
          stringChar = char;
        } else if (char === stringChar) {
          inString = false;
        }
        continue;
      }

      if (inString) {
        continue;
      }

      if (char === "/" && line[i + 1] === "/") {
        commentStart = i;
        break;
      } else if (char === "#") {
        commentStart = i;
        break;
      }
    }

    if (commentStart !== -1) {
      let excluded = false;
      for (const pattern of excludePatterns) {
        if (pattern.test(line)) {
          finalFilteredLines.push(line);
          excluded = true;
          break;
        }
      }
      if (excluded) {
        continue;
      }

      const beforeComment = line.substring(0, commentStart);

      if (beforeComment.trim() === "") {
        removedCount++;
      } else {
        const trimmedLine = beforeComment.trimRight();
        if (trimmedLine !== line) {
          removedCount++;
        }
        finalFilteredLines.push(trimmedLine);
      }
    } else {
      finalFilteredLines.push(line);
    }
  }

  return {
    text: finalFilteredLines.join("\n"),
    removedCount: removedCount,
  };
}

/**
 * Activates the extension.
 * Sets up commands and registers functionality for comment removal.
 *
 * @param context The extension context provided by VS Code
 */
export function activate(context: vscode.ExtensionContext) {
  console.log('Extension "remove-all-comments" is now active');


  /**
   * Command handler for removing comments from the active editor.
   * Shows diff view and allows reverting changes.
   */
  const removeCommentsCommand = vscode.commands.registerCommand(
    "remove-all-comments.removeComments",
    async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        vscode.window.showInformationMessage("No file open to remove comments");
        return;
      }

      const document = editor.document;
      const filePath = document.uri.fsPath;
      const originalText = document.getText();

      const result = removeCommentsFromText(originalText);

      try {
        await editor.edit((editBuilder) => {
          const start = new vscode.Position(0, 0);
          const end = new vscode.Position(
            document.lineCount - 1,
            document.lineAt(document.lineCount - 1).text.length
          );
          const range = new vscode.Range(start, end);
          editBuilder.replace(range, result.text);
        });

        if (result.removedCount > 0) {
          saveOriginalContent(filePath, originalText);
        }

        vscode.window
          .showInformationMessage(
            `Removed ${result.removedCount} comment lines from the file`,
            ...(result.removedCount > 0 ? ["Show Diff", "Revert Changes"] : [])
          )
          .then((selection) => {
            if (selection === "Show Diff") {
              showDiffEditor(filePath, originalText, result.text);
            } else if (selection === "Revert Changes") {
              revertChanges(filePath, originalText);
            }
          });
      } catch (error) {
        vscode.window.showErrorMessage("Failed to remove comments");
      }
    }
  );

  /**
   * Command handler for removing comments from all files in a folder.
   * Allows selecting file extensions to process.
   */
  const removeFolderCommentsCommand = vscode.commands.registerCommand(
    "remove-all-comments.removeFolderComments",
    async () => {
      const folderUri = await vscode.window.showOpenDialog({
        canSelectFiles: false,
        canSelectFolders: true,
        canSelectMany: false,
        openLabel: "Select Folder",
      });

      if (!folderUri || folderUri.length === 0) {
        return;
      }

      const folderPath = folderUri[0].fsPath;

      try {
        const foundExtensions = await vscode.window.withProgress<string[]>(
          {
            location: vscode.ProgressLocation.Notification,
            title: "Scanning folder for file types",
            cancellable: false,
          },
          async (progress) => {
            progress.report({ increment: 0, message: "Scanning folder..." });
            return scanFolderForExtensions(folderPath);
          }
        );

        if (foundExtensions.length === 0) {
          vscode.window.showInformationMessage(
            "No files found in the selected folder."
          );
          return;
        }

        foundExtensions.sort();
        const defaultExtensionsInput = foundExtensions.join(",");

        const fileExtensionsInput = await vscode.window.showInputBox({
          prompt: "Enter file extensions to process (comma separated)",
          placeHolder: defaultExtensionsInput,
          value: defaultExtensionsInput,
        });

        if (!fileExtensionsInput) {
          return;
        }

        const fileExtensions = fileExtensionsInput
          .split(",")
          .map((ext) => ext.trim().toLowerCase());

        let stats: ProcessStats = {
          processedFiles: 0,
          removedCommentLines: 0,
          skippedFiles: 0,
        };

        try {
          await vscode.window.withProgress(
            {
              location: vscode.ProgressLocation.Notification,
              title: "Removing comments",
              cancellable: true,
            },
            async (progress, token) => {
              stats = await processFolder(
                folderPath,
                fileExtensions,
                progress,
                token
              );
            }
          );

          vscode.window
            .showInformationMessage(
              `Processed ${stats.processedFiles} files, removed ${stats.removedCommentLines} comment lines, skipped ${stats.skippedFiles} files`,
              "Show Modified Files"
            )
            .then((selection) => {
              if (selection === "Show Modified Files") {
                showModifiedFilesList();
              }
            });
        } catch (error) {
          vscode.window.showErrorMessage(
            `Error processing folder: ${
              error instanceof Error ? error.message : String(error)
            }`
          );
        }
      } catch (error) {
        vscode.window.showErrorMessage(
          `Error: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
  );

  /**
   * Command handler for showing the list of modified files.
   */
  const showModifiedFilesCommand = vscode.commands.registerCommand(
    "remove-all-comments.showModifiedFiles",
    () => {
      showModifiedFilesList();
    }
  );

  /**
   * Recursively scans a folder to find all file extensions present.
   * Skips node_modules, .git and .vscode folders.
   *
   * @param folderPath Path to the folder to scan
   * @param extensions Set to store found extensions
   * @returns Array of unique file extensions
   */
  async function scanFolderForExtensions(
    folderPath: string,
    extensions: Set<string> = new Set()
  ): Promise<string[]> {
    const items = fs.readdirSync(folderPath);

    for (const item of items) {
      const itemPath = path.join(folderPath, item);
      try {
        const stat = fs.statSync(itemPath);

        if (stat.isDirectory()) {
          if (
            item === "node_modules" ||
            item === ".git" ||
            item === ".vscode"
          ) {
            continue;
          }

          await scanFolderForExtensions(itemPath, extensions);
        } else if (stat.isFile()) {
          const ext = path.extname(item).slice(1).toLowerCase();
          if (ext) {
            extensions.add(ext);
          }
        }
      } catch (error) {
        console.error(
          `Error accessing ${itemPath}: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      }
    }

    return Array.from(extensions);
  }

  /**
   * Processes a folder recursively to remove comments from files.
   *
   * @param folderPath Path to process
   * @param extensions Array of file extensions to process
   * @param progress Progress object for UI updates
   * @param token Cancellation token
   * @returns Statistics about the processing
   */
  async function processFolder(
    folderPath: string,
    extensions: string[],
    progress: vscode.Progress<{ message?: string; increment?: number }>,
    token: vscode.CancellationToken
  ): Promise<ProcessStats> {
    let stats: ProcessStats = {
      processedFiles: 0,
      removedCommentLines: 0,
      skippedFiles: 0,
    };

    const items = fs.readdirSync(folderPath);

    for (const item of items) {
      if (token.isCancellationRequested) {
        return stats;
      }

      const itemPath = path.join(folderPath, item);
      const stat = fs.statSync(itemPath);

      if (stat.isDirectory()) {
        if (item === "node_modules" || item === ".git") {
          continue;
        }

        const subStats = await processFolder(
          itemPath,
          extensions,
          progress,
          token
        );
        stats.processedFiles += subStats.processedFiles;
        stats.removedCommentLines += subStats.removedCommentLines;
        stats.skippedFiles += subStats.skippedFiles;
      } else if (stat.isFile()) {
        const ext = path.extname(item).slice(1).toLowerCase();

        if (extensions.includes(ext)) {
          try {
            progress.report({
              message: `Processing ${itemPath}`,
              increment: 1,
            });

            const content = fs.readFileSync(itemPath, "utf8");
            const result = removeCommentsFromText(content);

            if (result.removedCount > 0) {
              saveOriginalContent(itemPath, content);
              fs.writeFileSync(itemPath, result.text, "utf8");
              stats.removedCommentLines += result.removedCount;
            }

            stats.processedFiles++;
          } catch (error) {
            stats.skippedFiles++;
            console.error(
              `Error processing file ${itemPath}: ${
                error instanceof Error ? error.message : String(error)
              }`
            );
          }
        } else {
          stats.skippedFiles++;
        }
      }
    }

    return stats;
  }

  /**
   * Saves the original content of a file before modification.
   *
   * @param filePath Path to the file
   * @param originalContent Original file content
   */
  function saveOriginalContent(
    filePath: string,
    originalContent: string
  ): void {
    recentChanges.set(filePath, {
      originalContent,
      timestamp: Date.now(),
      fileName: path.basename(filePath),
    });

    cleanupOldChanges();
  }

  /**
   * Removes entries older than 30 minutes from the recentChanges map.
   */
  function cleanupOldChanges(): void {
    const now = Date.now();
    const MAX_AGE = 30 * 60 * 1000;

    for (const [filePath, data] of recentChanges.entries()) {
      if (now - data.timestamp > MAX_AGE) {
        recentChanges.delete(filePath);
      }
    }
  }

  /**
   * Shows a diff view comparing original and modified content.
   *
   * @param filePath Path to the modified file
   * @param originalContent Original file content
   * @param modifiedContent Modified file content
   */
  async function showDiffEditor(
    filePath: string,
    originalContent: string,
    modifiedContent?: string
  ): Promise<void> {
    if (!modifiedContent) {
      try {
        modifiedContent = fs.readFileSync(filePath, "utf8");
      } catch (error) {
        vscode.window.showErrorMessage(
          `Error reading current file content: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
        return;
      }
    }

    const tempDir = path.join(os.tmpdir(), "remove-all-comments");
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }

    const fileName = path.basename(filePath);
    const tempFilePath = path.join(tempDir, `original-${fileName}`);

    try {
      fs.writeFileSync(tempFilePath, originalContent, "utf8");

      const originalUri = vscode.Uri.file(tempFilePath);
      const modifiedUri = vscode.Uri.file(filePath);

      await vscode.commands.executeCommand(
        "vscode.diff",
        originalUri,
        modifiedUri,
        `Original vs Modified: ${fileName}`
      );
    } catch (error) {
      vscode.window.showErrorMessage(
        `Error creating diff view: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }

  /**
   * Reverts changes made to a file.
   *
   * @param filePath Path to the file to revert
   * @param originalContent Original content to restore
   */
  async function revertChanges(
    filePath: string,
    originalContent?: string
  ): Promise<void> {
    try {
      if (!originalContent) {
        const savedData = recentChanges.get(filePath);
        if (!savedData) {
          vscode.window.showWarningMessage(
            `No original content found for ${path.basename(filePath)}`
          );
          return;
        }
        originalContent = savedData.originalContent;
      }

      const documents = vscode.workspace.textDocuments;
      const openDocument = documents.find((doc) => doc.uri.fsPath === filePath);

      if (openDocument) {
        const edit = new vscode.WorkspaceEdit();
        const fullRange = new vscode.Range(
          0,
          0,
          openDocument.lineCount - 1,
          openDocument.lineAt(openDocument.lineCount - 1).text.length
        );
        edit.replace(openDocument.uri, fullRange, originalContent);
        await vscode.workspace.applyEdit(edit);
      } else {
        fs.writeFileSync(filePath, originalContent, "utf8");
        vscode.window.showInformationMessage(
          `Reverted changes to ${path.basename(filePath)}`
        );
      }

      recentChanges.delete(filePath);
    } catch (error) {
      vscode.window.showErrorMessage(
        `Error reverting changes: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }

  /**
   * Shows a list of recently modified files with options to view diff or revert changes.
   */
  async function showModifiedFilesList(): Promise<void> {
    if (recentChanges.size === 0) {
      vscode.window.showInformationMessage("No recently modified files found");
      return;
    }

    const sortedChanges = Array.from(recentChanges.entries()).sort(
      (a, b) => b[1].timestamp - a[1].timestamp
    );

    const items = sortedChanges.map(([filePath, data]) => ({
      label: data.fileName,
      description:
        vscode.workspace.asRelativePath(filePath) !== data.fileName
          ? vscode.workspace.asRelativePath(filePath)
          : undefined,
      detail: `Modified ${new Date(data.timestamp).toLocaleString()}`,
      filePath,
    }));

    const selection = await vscode.window.showQuickPick(items, {
      placeHolder: "Select a file to view diff or revert changes",
      canPickMany: false,
    });

    if (selection) {
      const action = await vscode.window.showQuickPick(
        [
          { label: "Show Diff", action: "diff" as const },
          { label: "Revert Changes", action: "revert" as const },
        ],
        {
          placeHolder: `Choose action for ${selection.label}`,
        }
      );

      if (action) {
        const filePath = selection.filePath;
        const originalContent = recentChanges.get(filePath)?.originalContent;

        if (action.action === "diff") {
          await showDiffEditor(filePath, originalContent ?? "");
        } else if (action.action === "revert") {
          await revertChanges(filePath, originalContent);
        }
      }
    }
  }

  context.subscriptions.push(removeCommentsCommand);
  context.subscriptions.push(removeFolderCommentsCommand);
  context.subscriptions.push(showModifiedFilesCommand);
}

/**
 * Handles extension deactivation.
 * Currently no cleanup is needed.
 */
export function deactivate() {}
