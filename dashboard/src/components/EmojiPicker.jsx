import React, { useMemo, useState } from 'react';
import { Search } from 'lucide-react';
import { EMOJI_GROUPS, searchEmoji } from '../lib/emoji';

// Pick an emoji to drop over the footage. The character is rasterised with the
// platform's own emoji font at the moment of picking (see lib/emojiRaster.js),
// so what you see in this grid is exactly what lands in the clip.
export default function EmojiPicker({ onPick, busy }) {
    const [query, setQuery] = useState('');
    const hits = useMemo(() => searchEmoji(query), [query]);

    const cell = (char) => (
        <button
            key={char}
            type="button"
            disabled={busy}
            onClick={() => onPick(char)}
            title={char}
            className="w-9 h-9 flex items-center justify-center text-[22px] leading-none
                rounded-input hover:bg-paper3 disabled:opacity-40 disabled:cursor-wait"
        >
            {char}
        </button>
    );

    return (
        <div className="rounded-input border border-rule p-2 flex flex-col gap-2">
            <div className="relative">
                <Search size={13} className="absolute left-2 top-1/2 -translate-y-1/2 text-muted" />
                <input
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder="search emoji — fire, cash, check…"
                    className="input-field text-[12px] py-1 pl-7"
                />
            </div>

            <div className="max-h-[26vh] overflow-y-auto pr-1">
                {hits ? (
                    hits.length ? (
                        <div className="flex flex-wrap gap-0.5">{hits.map(([char]) => cell(char))}</div>
                    ) : (
                        <p className="text-[11px] text-muted px-1 py-2">
                            nothing matches “{query}”. try a plainer word — fire, money, check.
                        </p>
                    )
                ) : (
                    EMOJI_GROUPS.map((group) => (
                        <div key={group.name} className="mb-1.5">
                            <p className="eyebrow mb-0.5">{group.name}</p>
                            <div className="flex flex-wrap gap-0.5">
                                {group.emoji.map(([char]) => cell(char))}
                            </div>
                        </div>
                    ))
                )}
            </div>
        </div>
    );
}
