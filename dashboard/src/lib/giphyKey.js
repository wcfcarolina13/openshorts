// Where this browser keeps its GIPHY key. Its own module so both the picker
// and the import call that follows a pick read the same one.
//
// The key never goes in a URL: it travels as X-Giphy-Key and the server makes
// the actual GIPHY request. A self-hosted deployment can skip it entirely and
// set GIPHY_API_KEY on the backend instead.

const KEY_STORE = 'giphy_key';

export const GIPHY_CONSOLE_URL = 'https://developers.giphy.com/dashboard/';

export const readGiphyKey = () => {
    try { return localStorage.getItem(KEY_STORE) || ''; } catch { return ''; }
};

export const writeGiphyKey = (value) => {
    try { localStorage.setItem(KEY_STORE, value); } catch { /* private mode */ }
};
