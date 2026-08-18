import React, { useEffect, useState } from 'react';
import {
  getLanguages, getOrgCopyright, putOrgCopyright, deleteOrgCopyright,
  type Language, type OrgCopyright,
} from '../../api/client';
import { RichLine, bodyToRich } from '../documents/RichLine';
import { detail } from './MembersPanel';

/**
 * THE ORG'S COPYRIGHT TEMPLATE, one body per language.
 *
 * The boilerplate every new booklet's back cover opens with — the line that names the
 * translator, the version and the holder, and that would otherwise be retyped for every
 * booklet in every edition.
 *
 * A template is COPIED, never inherited. Adding a back cover to a booklet writes these words
 * into it and the booklet owns them from there: its translator differs, and a house does not
 * want editing this page to silently rewrite every booklet it has already published. Editing
 * a template here therefore changes what the NEXT booklet opens with, and nothing that is
 * already on a page — which is the opposite of the images alongside, and deliberately so.
 */
export const CopyrightPanel: React.FC = () => {
  const [langs, setLangs] = useState<Language[]>([]);
  const [rows, setRows] = useState<OrgCopyright[]>([]);
  const [error, setError] = useState('');
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let alive = true;
    void Promise.all([getLanguages(), getOrgCopyright()])
      .then(([ls, cs]) => { if (alive) { setLangs(ls); setRows(cs); setLoaded(true); } })
      .catch(e => { if (alive) { setError(detail(e)); setLoaded(true); } });
    return () => { alive = false; };
  }, []);

  const bodyOf = (lang: string) => rows.find(r => r.lang === lang)?.body ?? '';

  const save = async (lang: string, html: string) => {
    const next = html.trim();
    if (next === bodyOf(lang).trim()) return;
    setError('');
    try {
      // Emptying a box DELETES the template rather than storing a blank one: an org that has
      // said nothing for a language and one that has said "nothing" want the same thing —
      // a booklet in that edition seeded with its own words, not with an empty paragraph.
      if (!next) {
        await deleteOrgCopyright(lang);
        setRows(rs => rs.filter(r => r.lang !== lang));
      } else {
        const row = await putOrgCopyright(lang, next);
        setRows(rs => [...rs.filter(r => r.lang !== lang), row]);
      }
    } catch (e) { setError(detail(e)); }
  };

  return (
    <div className="max-w-3xl">
      <h2 className="font-display text-lg mb-1">Copyright templates</h2>
      <p className="text-xs text-ink-soft mb-4">
        What a new booklet’s back cover opens with, per language. Adding a back cover copies
        these words into the booklet, which then edits its own — changing a template here does
        not touch a booklet already made. Select text for <em>italic</em>/<strong>bold</strong>;
        Enter starts a new line. Two variables resolve when the page prints:{' '}
        <code className="text-lapis">{'{{version}}'}</code> the declared version, and{' '}
        <code className="text-lapis">{'{{year}}'}</code> the year it was declared.
      </p>
      {error && <div className="text-sm text-red-700 mb-3">{error}</div>}
      {loaded && langs.length === 0 && (
        <div className="text-sm text-ink-soft">No languages are defined yet.</div>
      )}
      <div className="flex flex-col gap-2">
        {langs.map(l => {
          const body = bodyOf(l.code);
          return (
            <div key={l.code} className="px-4 py-3 rounded-lg bg-white"
                 style={{ boxShadow: '0 0 0 1px var(--gline-soft)' }}>
              <div className="flex items-center gap-2 mb-1.5">
                <span className="text-sm font-medium">{l.name}</span>
                <span className="text-xs text-ink-soft">{l.code}</span>
                <div className="flex-1" />
                {body
                  ? <span className="text-[11px] text-jade">a template</span>
                  : <span className="text-[11px] text-ink-soft">no template — booklets open blank</span>}
              </div>
              <RichLine
                // Re-seed when the stored value appears or goes: the box is uncontrolled, so
                // clearing one would otherwise leave the old words sitting in it.
                key={`${l.code}-${body ? 'own' : 'none'}`}
                html={bodyToRich(body)}
                placeholder="e.g. Translations by …, version {{version}} — Copyright © {{year}} …"
                onCommit={h => void save(l.code, h)} />
            </div>
          );
        })}
      </div>
    </div>
  );
};
