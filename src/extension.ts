import * as vscode from 'vscode';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { promisify } from 'util';

const writeFileAsync = promisify(fs.writeFile);
const unlinkAsync = promisify(fs.unlink);

const activeTempTabs: Map<string, TempTab> = new Map();
const debounceTimers: Map<string, NodeJS.Timeout> = new Map();
const DEBOUNCE_DELAY = 10;

const originalDecorationType = vscode.window.createTextEditorDecorationType({
  backgroundColor: 'rgba(135,206,250, 0.3)',
  borderRadius: '2px',
});

interface TempTab {
  tempFileName: string;
  tempUri: vscode.Uri;
  originalUri: string;
  disposables: vscode.Disposable[];
  isProgrammaticSave: boolean;
  isClosed: boolean;
  originalRanges: vscode.Range[]; // Birden fazla aralığı saklamak için dizi
}

export function activate(context: vscode.ExtensionContext) {
  const disposable = vscode.commands.registerCommand('extension.separate', async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      vscode.window.showInformationMessage('No active editor found.');
      return;
    }

    const selections = editor.selections;
    let selectedText = '';
    let originalRanges: vscode.Range[] = [];
    let isAltSelection = false;

    // Alt ile çoklu seçim kontrolü (basit yaklaşım)
    if (selections.length > 1) {
      isAltSelection = true;
    }

    if (isAltSelection) {
      // Alt ile seçim yapılmış
      for (const selection of selections) {
        selectedText += editor.document.getText(selection) + (selections.indexOf(selection) < selections.length - 1 ? '\n' : '');
        originalRanges.push(selection);
      }
    } else if (selections.length === 1 && !selections[0].isEmpty) {
      // Tek bir seçim var (Shift veya Ctrl ile yapılmış olabilir)
      selectedText = editor.document.getText(selections[0]);
      originalRanges.push(selections[0]);
    } else {
      vscode.window.showInformationMessage('Please select some text to separate.');
      return;
    }

    if (selectedText.trim().length === 0) {
      vscode.window.showInformationMessage('Selected text is empty.');
      return;
    }

    const originalUri = editor.document.uri.toString();

    if (debounceTimers.has(originalUri)) {
      clearTimeout(debounceTimers.get(originalUri)!);
    }

    const timer = setTimeout(async () => {
      debounceTimers.delete(originalUri);

      if (activeTempTabs.has(originalUri)) {
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

      const originalExtension = getFileExtension(editor.document.uri);
      const tempFileName = path.join(os.tmpdir(), `separate-${Date.now()}${originalExtension ? `.${originalExtension}` : ''}`);
      try {
        await writeFileAsync(tempFileName, selectedText);
      } catch (error) {
        vscode.window.showErrorMessage(`Failed to create temporary file: ${error}`);
        return;
      }

      const tempUri = vscode.Uri.file(tempFileName);

      let newDoc: vscode.TextDocument;
      try {
        newDoc = await vscode.workspace.openTextDocument(tempUri);
      } catch (error) {
        vscode.window.showErrorMessage(`Failed to open temporary file: ${error}`);
        return;
      }

      if (editor.document.languageId) {
        await vscode.languages.setTextDocumentLanguage(newDoc, editor.document.languageId);
      }

      try {
        await vscode.window.showTextDocument(newDoc, vscode.ViewColumn.Beside, false);
      } catch (error) {
        vscode.window.showErrorMessage(`Failed to show temporary document: ${error}`);
        return;
      }

      const tempTab: TempTab = {
        tempFileName,
        tempUri,
        originalUri,
        disposables: [],
        isProgrammaticSave: false,
        isClosed: false,
        originalRanges,
      };

      activeTempTabs.set(originalUri, tempTab);

      syncDocuments(editor.document, newDoc, tempTab);

      const originalEditor = vscode.window.visibleTextEditors.find(
        editor => editor.document.uri.toString() === originalUri
      );

      if (originalEditor) {
        originalEditor.setDecorations(originalDecorationType, originalRanges);
      }
    }, DEBOUNCE_DELAY);

    debounceTimers.set(originalUri, timer);
  });

  context.subscriptions.push(disposable);
  context.subscriptions.push(originalDecorationType);

  const saveListener = vscode.workspace.onDidSaveTextDocument(async (doc) => {
    activeTempTabs.forEach(async (tempTab) => {
      if (doc.uri.fsPath === tempTab.tempUri.fsPath) {
        if (!tempTab.isProgrammaticSave) {
          const originalDoc = vscode.workspace.textDocuments.find(d => d.uri.toString() === tempTab.originalUri);
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

function getFileExtension(uri: vscode.Uri): string | null {
  const ext = path.extname(uri.fsPath);
  if (ext.startsWith('.')) {
    return ext.slice(1);
  }
  return null;
}

function debounce(func: (...args: any[]) => void, delay: number) {
  let timer: NodeJS.Timeout;
  return (...args: any[]) => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      func(...args);
    }, delay);
  };
}

function syncDocuments(originalDoc: vscode.TextDocument, extractedDoc: vscode.TextDocument, tempTab: TempTab) {
  let isUpdating = false;
  let originalRanges = tempTab.originalRanges;
  let pendingChanges: { range: vscode.Range, text: string, rangeOffset: number, rangeLength: number }[] = [];
  let processingTimeout: NodeJS.Timeout | null = null;

  const debouncedAutosave = debounce(async () => {
    if (tempTab.isClosed) { return; }

    tempTab.isProgrammaticSave = true;
    try {
      if (tempTab.isClosed) { return; }
      await extractedDoc.save();
    } catch (error) {
      vscode.window.showErrorMessage(`Failed to save temporary file: ${error}`);
    } finally {
      tempTab.isProgrammaticSave = false;
    }
  }, 300);

  const updateDecorations = () => {
    const originalEditor = vscode.window.visibleTextEditors.find(
      editor => editor.document.uri.toString() === originalDoc.uri.toString()
    );

    if (originalEditor) {
      originalEditor.setDecorations(originalDecorationType, []);
      originalEditor.setDecorations(originalDecorationType, originalRanges);
    }
  };

  const clearDecorations = () => {
    const originalEditor = vscode.window.visibleTextEditors.find(
      editor => editor.document.uri.toString() === originalDoc.uri.toString()
    );

    if (originalEditor) {
      originalEditor.setDecorations(originalDecorationType, []);
    }
  };

  async function processPendingChanges() {
    if (!originalDoc || originalDoc.isClosed || pendingChanges.length === 0) { return; }

    const changes = [...pendingChanges];
    pendingChanges = [];

    let newRanges: vscode.Range[] = [...originalRanges];

    for (const change of changes) {
      const changeStart = change.range.start;
      const changeEnd = change.range.end;

      newRanges = newRanges.map(originalRange => {
        let newStart = originalRange.start;
        let newEnd = originalRange.end;

        // Değişiklik seçimin öncesindeyse
        if (changeEnd.isBeforeOrEqual(newStart)) {
          const lineDelta = change.text.split('\n').length - 1 - (changeEnd.line - changeStart.line);
          const charDelta = change.text.length - (changeEnd.character - changeStart.character);

          newStart = newStart.translate(lineDelta, changeEnd.line === newStart.line ? charDelta : 0);
          newEnd = newEnd.translate(lineDelta, changeEnd.line === newEnd.line ? charDelta : 0);
        }
        // Değişiklik seçimin içindeyse veya bitişiğindeyse
        else if (changeStart.isBeforeOrEqual(newEnd)) {
          const textLines = change.text.split('\n');
          const lineDelta = textLines.length - 1 - (change.range.end.line - change.range.start.line);
          const isInserting = change.text.length > 0;

          if (isInserting) {
            // Seçimin başlangıcına ekleme yapılıyorsa
            if (changeStart.isBefore(newStart)) {
              newStart = newStart.with(changeStart.line, changeStart.character);
            }
            // Seçimin sonuna ekleme yapılıyorsa
            if (changeEnd.isAfter(newEnd)) {
              newEnd = newEnd.with(changeEnd.line + lineDelta, (textLines.length === 1 ? changeEnd.character : textLines[textLines.length - 1].length));
            } else {
              newEnd = newEnd.translate(lineDelta, changeEnd.line === newEnd.line ? change.text.length - (changeEnd.character - changeStart.character) : 0);
            }
          } else {
            // Silme işlemi
            newEnd = newEnd.translate(lineDelta, -(changeEnd.character - changeStart.character));
          }
        }

        return new vscode.Range(newStart, newEnd);
      });
    }

    originalRanges = newRanges;

    // Yeni içeriği oluştur
    let newText = '';
    for (const range of originalRanges) {
      newText += originalDoc.getText(range) + (originalRanges.indexOf(range) < originalRanges.length - 1 ? '\n' : '');
    }

    // Güncellenmiş aralığı hesapla
    const fullRange = new vscode.Range(
      extractedDoc.positionAt(0),
      extractedDoc.positionAt(extractedDoc.getText().length)
    );

    // Düzenlemeyi uygula
    const edit = new vscode.WorkspaceEdit();
    edit.replace(extractedDoc.uri, fullRange, newText);
    await vscode.workspace.applyEdit(edit);

    // TempTab'ın originalRanges'ını güncelle
    tempTab.originalRanges = originalRanges;

    // Dekorasyonları güncelle
    updateDecorations();

    // Gecikmeli otomatik kaydetmeyi tetikle
    debouncedAutosave();
  }

  const originalToExtracted = vscode.workspace.onDidChangeTextDocument(async originalEvent => {
    if (tempTab.isClosed || isUpdating || originalEvent.document.uri.toString() !== originalDoc.uri.toString()) {
      return;
    }

    isUpdating = true;

    for (const change of originalEvent.contentChanges) {
      pendingChanges.push({
        range: change.range,
        text: change.text,
        rangeOffset: change.rangeOffset,
        rangeLength: change.rangeLength
      });
    }

    if (processingTimeout) {
      clearTimeout(processingTimeout);
    }

    processingTimeout = setTimeout(async () => {
      await processPendingChanges();
      processingTimeout = null;
      isUpdating = false;
      updateDecorations();
    }, 10);
  });

  const extractedToOriginal = vscode.workspace.onDidChangeTextDocument(async extractedEvent => {
    if (tempTab.isClosed || isUpdating || extractedEvent.document.uri.toString() !== extractedDoc.uri.toString()) {
      return;
    }

    isUpdating = true;

    const newText = extractedDoc.getText();
    const edits = new vscode.WorkspaceEdit();

    // Her bir originalRange için ayrı ayrı düzenleme yap
    let currentIndex = 0;
    for (let i = 0; i < originalRanges.length; i++) {
      const range = originalRanges[i];
      const nextIndex = newText.indexOf('\n', currentIndex);
      const textForRange = nextIndex !== -1 && i < originalRanges.length - 1
        ? newText.substring(currentIndex, nextIndex)
        : newText.substring(currentIndex);

      edits.replace(originalDoc.uri, range, textForRange);
      currentIndex += textForRange.length + (i < originalRanges.length - 1 ? 1 : 0);
    }

    await vscode.workspace.applyEdit(edits);

    // originalRanges'ı güncelle
    const updatedOriginalRanges = [];
    let textIndex = 0;
    for (const range of originalRanges) {
      const rangeText = extractedDoc.getText().substring(textIndex).split('\n')[0];
      const end = range.start.translate(0, rangeText.length);
      updatedOriginalRanges.push(new vscode.Range(range.start, end));
      textIndex += rangeText.length + 1;
    }
    originalRanges = updatedOriginalRanges;

    tempTab.originalRanges = originalRanges;
    updateDecorations();
    debouncedAutosave();

    isUpdating = false;
  });

  const closeHandler = vscode.window.onDidChangeVisibleTextEditors(async () => {
    const allTabs = vscode.window.tabGroups.all.flatMap(group => group.tabs);
    const tempFileUri = vscode.Uri.file(tempTab.tempFileName);
    const isExtractedDocVisible = allTabs.some(tab => {
      const tabUri = tab.input instanceof vscode.TabInputText ? tab.input.uri : null;
      return tabUri && tabUri.toString().toLowerCase() === tempFileUri.toString().toLowerCase();
    });

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

  tempTab.disposables.push(originalToExtracted, extractedToOriginal, closeHandler);
}

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
