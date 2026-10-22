// Splits "Radiohead, Blade Runner and Muji" into separate favourites, without an LLM.
// A transparent convenience parser, not an LLM. Quoted titles preserve commas and "and".
export function parseInterests(text) {
  if (typeof text !== 'string' || text.length > 3000) throw new Error('Use a sentence of up to 3,000 characters.');
  const quoted = [];
  const protectedText = text.replace(/["“]([^"”]+)["”]/g, (_, title) => { quoted.push(title); return `__TITLE${quoted.length - 1}__`; });
  // A period ends a sentence unless it closes a short abbreviation ("Dr. Martens", "St. Vincent", "Mt. Eerie").
  const phrases = protectedText.split(/[,;\n]+|\s+(?:and|also|plus|as well as)\s+|(?<!\b[A-Za-z]{1,3})[.!?](?:\s+|$)/i).map(part => part
    .replace(/^\s*(?:(?:oh|well|maybe)[,\s]+)?(?:(?:i(?:'m| am)\s+(?:really\s+)?(?:into|a fan of))|(?:i\s+(?:really\s+)?(?:like|love|enjoy|have an interest in|have this interest in|listen to|watch|play))|(?:my interests (?:are|include)))\s+/i, '')
    .replace(/__TITLE(\d+)__/g, (_, i) => quoted[Number(i)])
    .trim().replace(/^["'“”]+|["'“”]+$/g, '').trim()).filter(Boolean);
  const unique = [...new Set(phrases)];
  if (!unique.length) throw new Error('Tell us at least one thing you like.');
  if (unique.length > 12) throw new Error('Try up to 12 interests at a time.');
  return unique;
}
