import * as vscode from 'vscode';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { promisify } from 'util';

const writeFileAsync = promisify(fs.writeFile);
const unlinkAsync = promisify(fs.unlink);

// A map to track active temporary tabs for each original file
const activeTempTabs: Map<string, TempTab> = new Map();

// A map of debounce timers to prevent consecutive command executions
const debounceTimers: Map<string, NodeJS.Timeout> = new Map();

// Define the debounce delay in milliseconds
const DEBOUNCE_DELAY = 10;

// Decoration type for highlighting selected ranges in the original editor
const originalDecorationType = vscode.window.createTextEditorDecorationType({
  backgroundColor: 'rgba(135, 206, 250, 0.3)', // Light sky blue with transparency
  borderRadius: '2px',
});

// Interface to store temporary tab information
interface TempTab {
  tempFileName: string;
  tempUri: vscode.Uri;
  originalUri: string;
  disposables: vscode.Disposable[];
  isProgrammaticSave: boolean;
  isClosed: boolean;
  originalRanges: vscode.Range[]; // Array to store multiple ranges
}

/**
 * Finds the nth occurrence of a specified substring in a given string.
 * (Used when we want to split by '\n' between parts.)
 */
function findNthIndexOf(str: string, subStr: string, n: number): number {
  let index = -1;
  for (let i = 0; i < n; i++) {
    index = str.indexOf(subStr, index + 1);
    if (index === -1) {
      break;
    }
  }
  return index;
}

/**
 * The activation point of the extension.
 */
export function activate(context: vscode.ExtensionContext) {
  // Register the command
  const disposable = vscode.commands.registerCommand('extension.separate', async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      vscode.window.showInformationMessage('No active editor found.');
      return;
    }

    // Get all selections:
    const selections = editor.selections;
    let originalRanges: vscode.Range[] = [];

    // Check priority of selections made with Alt key
    // (In this example, you can adapt the altSelections logic to your needs.)
    const altSelections = selections.filter(
      sel => !sel.isEmpty // All non-empty selections
    );
    const isAltSelection = altSelections.length > 1;
    // We assume Alt key priority if multiple (scattered) selections are made

    if (isAltSelection) {
      // If Alt key was used for selection, ignore other selections
      originalRanges = altSelections.map(sel => new vscode.Range(sel.start, sel.end));
    } else if (selections.length === 1 && !selections[0].isEmpty) {
      // If a single selection was made with Shift/Ctrl
      originalRanges.push(new vscode.Range(selections[0].start, selections[0].end));
    } else {
      vscode.window.showInformationMessage('Please select the text to separate.');
      return;
    }

    // Extract text from selected ranges and validate ranges
    let selectedText = '';
    const validatedRanges: vscode.Range[] = [];
    for (const range of originalRanges) {
      const text = editor.document.getText(range);
      if (text.trim().length > 0) {
        // Add '\n' between lines; but check so it's not added to the last element
        selectedText += text + (originalRanges.indexOf(range) < originalRanges.length - 1 ? '\n' : '');
        validatedRanges.push(range);
      }
    }

    if (validatedRanges.length === 0) {
      vscode.window.showInformationMessage('Selected text is empty.');
      return;
    }

    const originalUri = editor.document.uri.toString();

    // Apply debounce to prevent consecutive executions
    if (debounceTimers.has(originalUri)) {
      clearTimeout(debounceTimers.get(originalUri)!);
    }

    const timer = setTimeout(async () => {
      debounceTimers.delete(originalUri);

      // Handle existing temporary tabs (close if a temporary tab was previously opened)
      if (activeTempTabs.has(originalUri)) {
        await closeExistingTempTab(originalUri);
      }

      // Get the original file extension
      const originalExtension = getFileExtension(editor.document.uri);

      // Create a temporary file with a unique name
      const tempFileName = path.join(
        os.tmpdir(),
        `separate-${Date.now()}${originalExtension ? `.${originalExtension}` : ''}`
      );
      try {
        // Write the selected text to the temporary file
        await writeFileAsync(tempFileName, selectedText);
      } catch (error) {
        vscode.window.showErrorMessage(`Failed to create temporary file: ${error}`);
        return;
      }

      const tempUri = vscode.Uri.file(tempFileName);

      // Open the temporary file in a new editor
      let newDoc: vscode.TextDocument;
      try {
        newDoc = await vscode.workspace.openTextDocument(tempUri);
      } catch (error) {
        vscode.window.showErrorMessage(`Failed to open temporary file: ${error}`);
        return;
      }

      // Ensure language mode matches the original
      if (editor.document.languageId) {
        await vscode.languages.setTextDocumentLanguage(newDoc, editor.document.languageId);
      }

      try {
        await vscode.window.showTextDocument(newDoc, vscode.ViewColumn.Beside, false);
      } catch (error) {
        vscode.window.showErrorMessage(`Failed to show temporary document: ${error}`);
        return;
      }

      // Create a TempTab object to track
      const tempTab: TempTab = {
        tempFileName,
        tempUri,
        originalUri,
        disposables: [],
        isProgrammaticSave: false,
        isClosed: false,
        originalRanges: validatedRanges, // Only store validated ranges
      };

      activeTempTabs.set(originalUri, tempTab);

      // Synchronize changes between the original and extracted documents
      syncDocuments(editor.document, newDoc, tempTab);

      // Update decorations immediately for selection
      const originalEditor = vscode.window.visibleTextEditors.find(
        e => e.document.uri.toString() === originalUri
      );

      if (originalEditor) {
        originalEditor.setDecorations(originalDecorationType, validatedRanges);
      }
    }, DEBOUNCE_DELAY);

    debounceTimers.set(originalUri, timer);
  });

  // Add the command and decoration type to the disposables list
  context.subscriptions.push(disposable, originalDecorationType);

  // Global listener for save events
  const saveListener = vscode.workspace.onDidSaveTextDocument(async (doc) => {
    activeTempTabs.forEach(async (tempTab) => {
      if (doc.uri.fsPath === tempTab.tempUri.fsPath) {
        // If the user manually saved the temporary document
        if (!tempTab.isProgrammaticSave) {
          const originalDoc = vscode.workspace.textDocuments.find(
            d => d.uri.toString() === tempTab.originalUri
          );
          if (originalDoc) {
            try {
              await originalDoc.save();
              vscode.window.showInformationMessage('Original document saved successfully.');
            } catch (error) {
              vscode.window.showErrorMessage(`Failed to save original document: ${error}`);
            }
          }
        }
      }
    });
  });
  context.subscriptions.push(saveListener);
}

/**
 * Helper function to get the file extension from a URI
 */
function getFileExtension(uri: vscode.Uri): string | null {
  const ext = path.extname(uri.fsPath);
  if (ext.startsWith('.')) {
    return ext.slice(1);
  }
  return null;
}

/**
 * Helper function to debounce a function
 */
function debounce(func: (...args: any[]) => void, delay: number) {
  let timer: NodeJS.Timeout;
  return (...args: any[]) => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      func(...args);
    }, delay);
  };
}

/**
 * Helper function to close an existing temporary tab
 */
async function closeExistingTempTab(originalUri: string) {
  const existingTempTab = activeTempTabs.get(originalUri)!;

  if (!existingTempTab.isClosed) {
    const allTabs = vscode.window.tabGroups.all.flatMap(group => group.tabs);
    const tempFileUri = existingTempTab.tempUri;

    const tabToClose = allTabs.find(tab => {
      const input = tab.input;
      if (input instanceof vscode.TabInputText) {
        return input.uri.toString() === tempFileUri.toString();
      }
      return false;
    });

    if (tabToClose) {
      try {
        await vscode.window.tabGroups.close(tabToClose);
      } catch (error) {
        vscode.window.showErrorMessage(`Failed to close existing temporary tab: ${error}`);
      }
    }

    existingTempTab.disposables.forEach(disposable => disposable.dispose());
    try {
      if (fs.existsSync(existingTempTab.tempFileName)) {
        await unlinkAsync(existingTempTab.tempFileName);
      }
    } catch (error) {
      vscode.window.showErrorMessage(`Failed to delete previous temporary file: ${error}`);
    }

    existingTempTab.isClosed = true;
    activeTempTabs.delete(originalUri);
  }
}

/**
 * Synchronizes changes between the original and extracted documents.
 * The most critical part here is the correct management of the isUpdating flag and the order of event triggering.
 */
function syncDocuments(originalDoc: vscode.TextDocument, extractedDoc: vscode.TextDocument, tempTab: TempTab) {
  // isUpdating: To prevent infinite loops and unnecessary triggers
  let isUpdating = false;

  // Keep a copy of the original ranges
  let originalRanges = [...tempTab.originalRanges];

  // Accumulate pending changes from the original document
  let pendingChanges: { range: vscode.Range; text: string; rangeOffset: number; rangeLength: number }[] = [];
  let processingTimeout: NodeJS.Timeout | null = null;

  // Debounce the autosave function with a 300ms delay
  const debouncedAutosave = debounce(async () => {
    if (tempTab.isClosed) { return; }
    tempTab.isProgrammaticSave = true;
    try {
      if (!tempTab.isClosed) {
        await extractedDoc.save();
      }
    } catch (error) {
      vscode.window.showErrorMessage(`Failed to save temporary file: ${error}`);
    } finally {
      tempTab.isProgrammaticSave = false;
    }
  }, 300);

  /**
   * Update decorations in the original editor
   */
  const updateDecorations = () => {
    const originalEditor = vscode.window.visibleTextEditors.find(
      editor => editor.document.uri.toString() === originalDoc.uri.toString()
    );
    if (originalEditor) {
      originalEditor.setDecorations(originalDecorationType, []);
      originalEditor.setDecorations(originalDecorationType, originalRanges);
    }
  };

  /**
   * Clear decorations
   */
  const clearDecorations = () => {
    const originalEditor = vscode.window.visibleTextEditors.find(
      editor => editor.document.uri.toString() === originalDoc.uri.toString()
    );
    if (originalEditor) {
      originalEditor.setDecorations(originalDecorationType, []);
    }
  };

  /**
   * Process pending changes
   */
  async function processPendingChanges() {
    if (!originalDoc || originalDoc.isClosed || pendingChanges.length === 0) {
      return;
    }

    const changes = [...pendingChanges];
    pendingChanges = [];

    // Apply changes to original ranges and calculate new ranges
    const newRanges = applyChangesToOriginalRanges(originalRanges, changes, originalDoc);

    // Create new content and update the temporary document accordingly.
    // We take the text from each originalRange in order (so the order is not broken!)
    // and concatenate them with '\n' in between.
    let newExtractedText = '';
    for (let i = 0; i < newRanges.length; i++) {
      const txt = originalDoc.getText(newRanges[i]);
      newExtractedText += txt + (i < newRanges.length - 1 ? '\n' : '');
    }

    // We set isUpdating = true before updating the temporary document
    // but prevent other events from triggering until applyEdit is finished.
    isUpdating = true;

    const edit = new vscode.WorkspaceEdit();
    const fullRange = new vscode.Range(
      extractedDoc.positionAt(0),
      extractedDoc.positionAt(extractedDoc.getText().length)
    );
    edit.replace(extractedDoc.uri, fullRange, newExtractedText);

    await vscode.workspace.applyEdit(edit);

    // Update original ranges and decorations
    originalRanges = newRanges;
    tempTab.originalRanges = originalRanges;
    updateDecorations();

    // Autosave
    debouncedAutosave();

    // Update is now finished
    isUpdating = false;
  }

  /**
   * Listener for changes in the original document
   */
  const originalToExtracted = vscode.workspace.onDidChangeTextDocument(async (originalEvent) => {
    if (
      tempTab.isClosed ||
      isUpdating ||
      originalEvent.document.uri.toString() !== originalDoc.uri.toString()
    ) {
      return;
    }

    // Accumulate changes from the original document
    for (const change of originalEvent.contentChanges) {
      pendingChanges.push({
        range: change.range,
        text: change.text,
        rangeOffset: change.rangeOffset,
        rangeLength: change.rangeLength,
      });
    }

    // Use a timer to process these changes with a short delay
    if (processingTimeout) {
      clearTimeout(processingTimeout);
    }

    processingTimeout = setTimeout(async () => {
      await processPendingChanges();
      processingTimeout = null;
      updateDecorations();
    }, DEBOUNCE_DELAY);
  });

  /**
   * Listener for changes in the temporary (extracted) document
   */
  const extractedToOriginal = vscode.workspace.onDidChangeTextDocument(async (extractedEvent) => {
    if (
      tempTab.isClosed ||
      isUpdating ||
      extractedEvent.document.uri.toString() !== extractedDoc.uri.toString()
    ) {
      return;
    }

    // If there is a change in the temporary document, apply this change to the original
    isUpdating = true;

    const newText = extractedDoc.getText();
    const newLines = newText.split('\n');
    const edits = new vscode.WorkspaceEdit();
    const newOriginalRanges: vscode.Range[] = [];

    // Find the corresponding line in the original document for each line
    for (let i = 0; i < newLines.length; i++) {
      const newLine = newLines[i];

      // Find the relevant range in the original document (over ordered ranges)
      let correspondingRange: vscode.Range | undefined;
      for (const range of tempTab.originalRanges) {
        const originalText = originalDoc.getText(range);
        if (originalText.includes(newLine)) {
          correspondingRange = range;
          break;
        }
      }

      // If a matching range is found, update the original document
      if (correspondingRange) {
        edits.replace(originalDoc.uri, correspondingRange, newLine);

        // Calculate and add the new range
        const lineDelta = (newLine.match(/\n/g) || []).length;
        const lines = newLine.split('\n');
        const lastLineText = lines.length > 1 ? lines[lines.length - 1] : newLine;
        const charDelta = lastLineText.length - (correspondingRange.end.character - correspondingRange.start.character);

        const updatedRange = new vscode.Range(
          correspondingRange.start,
          correspondingRange.end.translate(lineDelta, charDelta)
        );
        newOriginalRanges.push(updatedRange);
      }
    }

    await vscode.workspace.applyEdit(edits);

    // Update originalRanges
    originalRanges = newOriginalRanges;
    tempTab.originalRanges = originalRanges;

    updateDecorations();
    debouncedAutosave();
    isUpdating = false;
  });

  /**
   * Listener for closing the extracted (temp) document
   */
  const closeHandler = vscode.window.onDidChangeVisibleTextEditors(async () => {
    const allTabs = vscode.window.tabGroups.all.flatMap(group => group.tabs);
    const tempFileUri = vscode.Uri.file(tempTab.tempFileName);
    const isExtractedDocVisible = allTabs.some(tab => {
      const tabUri = tab.input instanceof vscode.TabInputText ? tab.input.uri : null;
      return tabUri && tabUri.toString().toLowerCase() === tempFileUri.toString().toLowerCase();
    });

    // If the extracted document is no longer visible, clean up resources
    if (!isExtractedDocVisible) {
      tempTab.isClosed = true;
      clearDecorations();
      tempTab.disposables.forEach(disposable => disposable.dispose());

      if (fs.existsSync(tempTab.tempFileName)) {
        try {
          await unlinkAsync(tempTab.tempFileName);
        } catch (error) {
          vscode.window.showErrorMessage(`Failed to delete temporary file: ${error}`);
        }
      }

      activeTempTabs.delete(tempTab.originalUri);
    }
  });

  // Add listeners to the TempTab's disposables list
  tempTab.disposables.push(originalToExtracted, extractedToOriginal, closeHandler);
}

/**
 * Helper function that applies changes to original ranges and returns the new ranges.
 * (How should originalRanges be updated after changes in the original document?)
 */
function applyChangesToOriginalRanges(
  originalRanges: vscode.Range[],
  changes: { range: vscode.Range; text: string }[],
  originalDoc: vscode.TextDocument
): vscode.Range[] {
  let newRanges: vscode.Range[] = [...originalRanges];

  // Apply changes to original ranges
  for (const change of changes) {
    const changeStart = change.range.start;
    const changeEnd = change.range.end;

    newRanges = newRanges.map(originalRange => {
      let newStart = originalRange.start;
      let newEnd = originalRange.end;

      // If the change completely covers or intersects this range
      if (changeStart.isBeforeOrEqual(newEnd) && changeEnd.isAfterOrEqual(newStart)) {
        // Adjust start
        if (changeStart.isBefore(newStart)) {
          newStart = changeStart;
        }
        // Adjust end
        if (changeEnd.isAfter(newEnd)) {
          // Add line count and character difference
          newEnd = changeEnd.translate(0, change.text.length);
        } else {
          newEnd = changeEnd.translate(
            0,
            change.text.length - (changeEnd.character - changeStart.character)
          );
        }
      }
      // If the change is to the left of the range
      else if (changeEnd.isBefore(newStart)) {
        const lineDelta = (change.text.match(/\n/g) || []).length - (changeEnd.line - changeStart.line);
        const charDelta = change.text.length - (changeEnd.character - changeStart.character);
        newStart = newStart.translate(lineDelta, charDelta);
        newEnd = newEnd.translate(lineDelta, charDelta);
      }

      return new vscode.Range(newStart, newEnd);
    });
  }

  // Merge intersecting ranges (for a cleaner result)
  newRanges.sort((a, b) => a.start.compareTo(b.start));
  const mergedRanges: vscode.Range[] = [];
  if (newRanges.length > 0) {
    let currentRange = newRanges[0];
    for (let i = 1; i < newRanges.length; i++) {
      const nextRange = newRanges[i];
      if (currentRange.end.isAfterOrEqual(nextRange.start)) {
        const newEnd = currentRange.end.isAfterOrEqual(nextRange.end)
          ? currentRange.end
          : nextRange.end;
        currentRange = new vscode.Range(currentRange.start, newEnd);
      } else {
        mergedRanges.push(currentRange);
        currentRange = nextRange;
      }
    }
    mergedRanges.push(currentRange);
  }

  return mergedRanges;
}

/**
 * Cleanup operations when the extension is deactivated
 */
export function deactivate() {
  activeTempTabs.forEach(async (tempTab) => {
    try {
      await unlinkAsync(tempTab.tempFileName);
    } catch (error) {
      console.error(`Failed to delete temporary file during deactivation: ${error}`);
    }
    tempTab.disposables.forEach(disposable => disposable.dispose());
  });

  const visibleEditors = vscode.window.visibleTextEditors;
  visibleEditors.forEach(editor => {
    editor.setDecorations(originalDecorationType, []);
  });

  originalDecorationType.dispose();
}
