import * as vscode from 'vscode';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { promisify } from 'util';

const writeFileAsync = promisify(fs.writeFile);
const unlinkAsync = promisify(fs.unlink);

// A map to keep track of active temporary tabs for each original document
const activeTempTabs: Map<string, TempTab> = new Map();

// Debounce timer map to prevent rapid successive command executions
const debounceTimers: Map<string, NodeJS.Timeout> = new Map();

// Define a debounce delay in milliseconds
const DEBOUNCE_DELAY = 10;

// Define decoration types for original editor
const originalDecorationType = vscode.window.createTextEditorDecorationType({
	backgroundColor: 'rgba(135,206,250, 0.3)', // Light sky blue with transparency
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
	originalRange: vscode.Range; // Changed from Selection to Range
}

export function activate(context: vscode.ExtensionContext) {
	const disposable = vscode.commands.registerCommand('extension.separate', async () => {
		const editor = vscode.window.activeTextEditor;
		if (!editor) {
			vscode.window.showInformationMessage('No active editor found.');
			return;
		}

		const selection = editor.selection;
		if (selection.isEmpty) {
			vscode.window.showInformationMessage('Please select some text to separate.');
			return;
		}

		const selectedText = editor.document.getText(selection);
		if (selectedText.trim().length === 0) {
			vscode.window.showInformationMessage('Selected text is empty.');
			return;
		}

		const originalUri = editor.document.uri.toString();

		// Implement debounce to prevent rapid successive executions
		if (debounceTimers.has(originalUri)) {
			clearTimeout(debounceTimers.get(originalUri)!);
		}

		const timer = setTimeout(async () => {
			debounceTimers.delete(originalUri);

			// Handle existing temp tabs
			if (activeTempTabs.has(originalUri)) {
				const existingTempTab = activeTempTabs.get(originalUri)!;

				if (!existingTempTab.isClosed) {
					// Close the existing temp tab programmatically
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

					// Clean up associated resources
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

			// Determine the original file extension
			const originalExtension = getFileExtension(editor.document.uri);

			// Create a temporary file with a unique name and the same extension as the original
			const tempFileName = path.join(os.tmpdir(), `separate-${Date.now()}${originalExtension ? `.${originalExtension}` : ''}`);
			try {
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

			// Ensure the language mode matches the original
			if (editor.document.languageId) {
				await vscode.languages.setTextDocumentLanguage(newDoc, editor.document.languageId);
			}

			try {
				await vscode.window.showTextDocument(newDoc, vscode.ViewColumn.Beside, false);
			} catch (error) {
				vscode.window.showErrorMessage(`Failed to show temporary document: ${error}`);
				return;
			}

			// Create a TempTab object to keep track
			const tempTab: TempTab = {
				tempFileName,
				tempUri,
				originalUri,
				disposables: [],
				isProgrammaticSave: false,
				isClosed: false,
				originalRange: selection,
			};

			activeTempTabs.set(originalUri, tempTab);

			// Sync changes between original and extracted documents
			syncDocuments(editor.document, newDoc, tempTab);

			// Immediately update decorations for the selection
			const originalEditor = vscode.window.visibleTextEditors.find(
				editor => editor.document.uri.toString() === originalUri
			);

			if (originalEditor) {
				originalEditor.setDecorations(originalDecorationType, [selection]);
			}
		}, DEBOUNCE_DELAY);

		debounceTimers.set(originalUri, timer);
	});

	context.subscriptions.push(disposable);

	// Register decoration types for disposal
	context.subscriptions.push(originalDecorationType);

	// Global listener for save events
	const saveListener = vscode.workspace.onDidSaveTextDocument(async (doc) => {
		// Iterate through activeTempTabs to check if the saved doc is a temporary tab
		activeTempTabs.forEach(async (tempTab) => {
			if (doc.uri.fsPath === tempTab.tempUri.fsPath) {
				if (!tempTab.isProgrammaticSave) {
					// User manually saved the temporary document, save the original document
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

// Helper function to get file extension from a URI
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
	let originalRange = tempTab.originalRange;
	let pendingChanges: vscode.TextDocumentContentChangeEvent[] = [];
	let processingTimeout: NodeJS.Timeout | null = null;

	// Debounce the autosave function with a delay of 300ms
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

	// Function to update decorations
	const updateDecorations = () => {
		const originalEditor = vscode.window.visibleTextEditors.find(
			editor => editor.document.uri.toString() === originalDoc.uri.toString()
		);

		if (originalEditor) {
			originalEditor.setDecorations(originalDecorationType, []);
			const originalRangeDeco = new vscode.Range(originalRange.start, originalRange.end);
			originalEditor.setDecorations(originalDecorationType, [originalRangeDeco]);
		}
	};

	// Function to clear decorations
	const clearDecorations = () => {
		const originalEditor = vscode.window.visibleTextEditors.find(
			editor => editor.document.uri.toString() === originalDoc.uri.toString()
		);

		if (originalEditor) {
			originalEditor.setDecorations(originalDecorationType, []);
		}
	};

	// Function to process pending changes
	async function processPendingChanges() {
		if (!originalDoc || originalDoc.isClosed || pendingChanges.length === 0) { return; }

		const changes = [...pendingChanges];
		pendingChanges = [];

		let newStart = originalRange.start;
		let newEnd = originalRange.end;

		for (const change of changes) {
			const changeStart = change.range.start;
			const changeEnd = change.range.end;
			const isInsertion = change.text.length > 0;

			// Check if change is before the selection
			if (changeEnd.isBefore(newStart)) {
				// Adjust both newStart and newEnd
				const lineDelta = change.text.split('\n').length - 1 - (changeEnd.line - changeStart.line);
				const charDelta = change.text.length - (changeEnd.character - changeStart.character);

				newStart = newStart.translate(lineDelta, changeEnd.line === newStart.line ? charDelta : 0);
				newEnd = newEnd.translate(lineDelta, changeEnd.line === newEnd.line ? charDelta : 0);
			} else if (changeStart.isAfter(newEnd)) {
				// Change is after the selection; no adjustment needed
			} else {
				// Change overlaps with or is adjacent to the selection
				if (changeStart.isBefore(newStart)) {
					const lineDelta = change.text.split('\n').length - 1 - (changeEnd.line - changeStart.line);
					const charDelta = change.text.length - (changeEnd.character - changeStart.character);

					newStart = newStart.translate(lineDelta, changeEnd.line === newStart.line ? charDelta : 0);
				}
				if (changeEnd.isAfter(newEnd)) {
					// Adjust newEnd if the change extends beyond the current selection
					const lineDelta = change.text.split('\n').length - 1 - (changeEnd.line - changeStart.line);
					const charDelta = change.text.length - (changeEnd.character - changeStart.character);

					newEnd = newEnd.translate(lineDelta, changeEnd.line === newEnd.line ? charDelta : 0);
				} else {
					// Adjust newEnd based on the change
					const lineDelta = change.text.split('\n').length - 1 - (changeEnd.line - changeStart.line);
					const charDelta = change.text.length - (changeEnd.character - changeStart.character);

					newEnd = newEnd.translate(lineDelta, changeEnd.line === newEnd.line ? charDelta : 0);
				}

				// If it's an insertion adjacent to the selection, expand the selection
				if (isInsertion) {
					// Check if insertion is adjacent to the selection
					if (changeStart.isEqual(newEnd) || changeEnd.isEqual(newStart)) {
						const insertedLines = change.text.split('\n').length - 1;
						const lastLine = change.text.split('\n').pop() || '';
						const insertedChars = insertedLines > 0 ? lastLine.length : change.text.length;

						if (changeStart.isEqual(newEnd)) {
							// Insertion after the selection
							newEnd = newEnd.translate(insertedLines, insertedLines > 0 ? insertedChars - newEnd.character : insertedChars);
						} else if (changeEnd.isEqual(newStart)) {
							// Insertion before the selection
							newStart = newStart.translate(insertedLines, insertedLines > 0 ? insertedChars - newStart.character : insertedChars);
						}
					}
				}
			}
		}

		originalRange = new vscode.Range(newStart, newEnd);

		// Update the extracted document with the new content
		const newText = originalDoc.getText(originalRange);
		const edit = new vscode.WorkspaceEdit();
		const fullRange = new vscode.Range(
			extractedDoc.positionAt(0),
			extractedDoc.positionAt(extractedDoc.getText().length)
		);
		edit.replace(extractedDoc.uri, fullRange, newText);
		await vscode.workspace.applyEdit(edit);

		// Update tempTab's originalRange
		tempTab.originalRange = originalRange;

		// Update decorations
		updateDecorations();

		// Trigger debounced autosave
		debouncedAutosave();
	}

	// Listener for changes in the original document
	const originalToExtracted = vscode.workspace.onDidChangeTextDocument(async originalEvent => {
		if (tempTab.isClosed || isUpdating ||
			originalEvent.document.uri.toString() !== originalDoc.uri.toString()) {
			return;
		}

		isUpdating = true;

		pendingChanges.push(...originalEvent.contentChanges);

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

	// Listener for changes in the extracted document
	const extractedToOriginal = vscode.workspace.onDidChangeTextDocument(async extractedEvent => {
		if (tempTab.isClosed || isUpdating ||
			extractedEvent.document.uri.toString() !== extractedDoc.uri.toString()) {
			return;
		}

		isUpdating = true;

		const newText = extractedDoc.getText();
		const edit = new vscode.WorkspaceEdit();
		edit.replace(originalDoc.uri, originalRange, newText);
		await vscode.workspace.applyEdit(edit);

		originalRange = new vscode.Range(
			originalRange.start,
			originalRange.start.translate(
				newText.split('\n').length - 1,
				newText.length
			)
		);

		tempTab.originalRange = originalRange;
		updateDecorations();
		debouncedAutosave();

		isUpdating = false;
	});

	// Listener for closing the extracted document
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
	// Clean up all active temporary tabs on extension deactivation
	activeTempTabs.forEach(async (tempTab) => {
		try {
			await unlinkAsync(tempTab.tempFileName);
		} catch (error) {
			console.error(`Failed to delete temporary file during deactivation: ${error}`);
		}
		tempTab.disposables.forEach(disposable => disposable.dispose());
	});

	// Clear all decorations
	const visibleEditors = vscode.window.visibleTextEditors;
	visibleEditors.forEach(editor => {
		editor.setDecorations(originalDecorationType, []);
	});

	// Dispose decoration types
	originalDecorationType.dispose();
}
