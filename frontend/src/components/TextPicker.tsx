import React, { useEffect, useRef } from 'react';
import { Upload, Trash2, FileText, ChevronRight, FileCode, GitBranch, CopyPlus } from 'lucide-react';
import { useTextStore } from '../store/useTextStore';
import type { Route } from '../App';

interface TextPickerProps {
  onNavigate: (route: Route) => void;
}

export const TextPicker: React.FC<TextPickerProps> = ({ onNavigate }) => {
  const { texts, fetchTexts, uploadNewFile, importCherrytreeFile, loadText, removeText, deriveSecondary, cloneWithEdits, loading } = useTextStore();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const ctdInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    fetchTexts();
  }, [fetchTexts]);

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      try {
        await uploadNewFile(e.target.files[0]);
        onNavigate('/workspace');
      } catch (err) {
        alert("Failed to upload text");
      }
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const handleCtdChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      try {
        await importCherrytreeFile(e.target.files[0]);
        onNavigate('/workspace');
      } catch (err: any) {
        alert("Failed to import CherryTree file: " + (err?.message || err));
      }
      if (ctdInputRef.current) ctdInputRef.current.value = '';
    }
  };

  const handleSelectDoc = async (id: number) => {
    await loadText(id);
    onNavigate('/workspace');
  };

  const handleDerive = async (parentId: number) => {
    try {
      const newId = await deriveSecondary(parentId);
      await handleSelectDoc(newId);
    } catch (err: any) {
      alert('Failed to derive secondary text: ' + (err?.message || err));
    }
  };

  // Duplicate a primary text with its reversible edits/deletions baked into the copy.
  const handleClone = async (id: number) => {
    try {
      await cloneWithEdits(id);
    } catch (err: any) {
      alert('Failed to duplicate text: ' + (err?.message || err));
    }
  };

  const titleById = new Map(texts.map(t => [t.id, t.title]));

  return (
    <div className="max-w-3xl mx-auto w-full mt-10 px-4 pb-12">
      {/* Eyebrow + display title — restrained "arrival" feel without the full descent gradient. */}
      <div className="text-center mb-6">
        <div className="text-[11px] tracking-[0.4em] uppercase text-bronze mb-2">
          Oral Teachings Archive
        </div>
        <h1 className="font-display text-4xl text-lapis font-medium">Your texts</h1>
        <div className="font-display italic text-ink-soft mt-1">choose a text, or bring one in</div>
      </div>

      <div
        className="bg-cream rounded-2xl overflow-hidden"
        style={{
          border: '1px solid var(--cline)',
          boxShadow: '0 16px 40px -18px rgba(7,27,56,0.50)',
        }}
      >
        {/* Upload / Import Area */}
        <div
          className="p-6 grid grid-cols-1 md:grid-cols-2 gap-4 bg-cream-hi"
          style={{ borderBottom: '1px solid var(--cline)' }}
        >
          <button
            type="button"
            className="rounded-xl p-6 flex flex-col items-center justify-center text-center cursor-pointer transition-colors bg-white hover:bg-cream"
            style={{ border: '1px dashed var(--cline)' }}
            onClick={() => fileInputRef.current?.click()}
          >
            <Upload className="w-8 h-8 text-bronze mb-3" />
            <h3 className="font-display text-lg text-lapis">Upload plain text</h3>
            <p className="text-xs text-ink-soft mt-1">.txt files only</p>
            <input
              type="file"
              className="hidden"
              accept=".txt"
              ref={fileInputRef}
              onChange={handleFileChange}
            />
          </button>
          <button
            type="button"
            className="rounded-xl p-6 flex flex-col items-center justify-center text-center cursor-pointer transition-colors bg-white hover:bg-cream"
            style={{ border: '1px dashed var(--gline)' }}
            onClick={() => ctdInputRef.current?.click()}
          >
            <FileCode className="w-8 h-8 text-gold mb-3" />
            <h3 className="font-display text-lg text-lapis">Import CherryTree</h3>
            <p className="text-xs text-ink-soft mt-1">
              .ctd — preserves nodes, headings, italic/bold/underline/strikethrough as tags
            </p>
            <input
              type="file"
              className="hidden"
              accept=".ctd,.xml"
              ref={ctdInputRef}
              onChange={handleCtdChange}
            />
          </button>
        </div>

        {/* List Areas */}
        <div className="p-0 bg-cream-hi">
          <div
            className="px-6 py-4 bg-cream-hi"
            style={{ borderBottom: '1px solid var(--cline)' }}
          >
            <h2 className="font-display text-xl text-lapis">Your texts</h2>
          </div>

          <ul style={{ borderColor: 'var(--cline)' }} className="divide-y divide-bronze/10">
            {loading && texts.length === 0 ? (
              <li className="p-6 text-center text-ink-soft">Loading...</li>
            ) : texts.length === 0 ? (
              <li className="p-6 text-center text-ink-soft text-sm">No texts found. Upload one to begin.</li>
            ) : (
              texts.map(doc => (
                <li key={doc.id} className="flex items-center justify-between p-4 hover:bg-cream transition-colors group">
                  <div
                    className="flex items-center gap-4 cursor-pointer flex-1"
                    onClick={() => handleSelectDoc(doc.id)}
                  >
                    <div
                      className="h-10 w-10 rounded-lg flex items-center justify-center text-gold"
                      style={{
                        background: 'rgba(236,179,32,0.12)',
                        boxShadow: 'inset 0 0 0 1px var(--cline)',
                      }}
                    >
                      <FileText size={20} />
                    </div>
                    <div>
                      <h4 className="font-display text-lg text-lapis group-hover:text-vermilion transition-colors flex items-center gap-2">
                        {doc.title}
                        {doc.text_type === 'secondary' && (
                          <span className="text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded bg-lapis/10 text-lapis font-mono">
                            secondary
                          </span>
                        )}
                        {doc.cloned_from_text_id != null && (
                          <span className="text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded bg-teal-500/10 text-teal-700 dark:text-teal-300 font-mono">
                            duplicate
                          </span>
                        )}
                        {doc.has_clone && (
                          <span className="text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded bg-amber-500/10 text-amber-700 dark:text-amber-300 font-mono">
                            original
                          </span>
                        )}
                      </h4>
                      <p className="text-xs text-ink-soft mt-0.5 font-mono">
                        {doc.text_type === 'secondary'
                          ? `derived from ${titleById.get(doc.parent_text_id ?? -1) ?? 'parent'}`
                          : doc.cloned_from_text_id != null
                          ? `duplicate of ${titleById.get(doc.cloned_from_text_id) ?? 'a deleted text'}`
                          : `${doc.span_count} tags · added ${new Date(doc.created_at).toLocaleDateString()}`}
                      </p>
                    </div>
                  </div>

                  <div className="flex items-center gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
                    {doc.text_type === 'primary' && (
                      <button
                        onClick={() => handleClone(doc.id)}
                        className="p-2 text-bronze hover:text-teal-600 hover:bg-teal-500/10 rounded-md transition-colors"
                        title="Duplicate with edits baked in (applies deletions permanently to the copy)"
                      >
                        <CopyPlus size={18} />
                      </button>
                    )}
                    {doc.text_type === 'primary' && (
                      <button
                        onClick={() => handleDerive(doc.id)}
                        className="p-2 text-bronze hover:text-lapis hover:bg-lapis/10 rounded-md transition-colors"
                        title="Derive secondary text"
                      >
                        <GitBranch size={18} />
                      </button>
                    )}
                    <button
                      onClick={() => removeText(doc.id)}
                      className="p-2 text-bronze hover:text-vermilion-deep hover:bg-vermilion/10 rounded-md transition-colors"
                      title="Delete text"
                    >
                      <Trash2 size={18} />
                    </button>
                    <button
                      onClick={() => handleSelectDoc(doc.id)}
                      className="p-2 text-bronze hover:text-gold hover:bg-gold/10 rounded-md transition-colors"
                      title="Open Tag Editor"
                    >
                      <ChevronRight size={18} />
                    </button>
                  </div>
                </li>
              ))
            )}
          </ul>
        </div>

      </div>
    </div>
  );
};
