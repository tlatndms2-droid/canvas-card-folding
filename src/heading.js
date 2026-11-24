import { Marked } from "marked";

const markdown = new Marked();
const MARKDOWN_PREFIX = /^\uFEFF?(?:---[ \t]*\r?\n(?:[\s\S]*?\r?\n)?---[ \t]*(?:\r?\n|$))?/;

markdown.use({
  extensions: [{
    name: "obsidianComment",
    level: "block",
    tokenizer(source) {
      const raw = /^ {0,3}%%[\s\S]*?%%[ \t]*(?:\n|$)/.exec(source)?.[0];
      if (raw) return { type: "obsidianComment", raw };
    },
  }],
});

function plainText(tokens) {
  return tokens.map(token => {
    if (token.type === "html") return "";
    if (token.type === "br") return " ";
    if (token.type === "codespan" || token.type === "escape") {
      return token.text.replace(/[&%\[\]]/g, char => "&#" + char.charCodeAt(0) + ";");
    }
    if (token.tokens) return plainText(token.tokens);
    return token.text ?? "";
  }).join("");
}

export function firstHeading(text, ownerDocument) {
  const source = text.replace(MARKDOWN_PREFIX, "");
  const heading = markdown.lexer(source).find(token => token.type === "heading");
  if (!heading) return null;

  const decoder = ownerDocument.createElement("textarea");
  const decodeEntities = value => value.replace(/&(?:#[0-9]+|#x[\da-f]+|[a-z][a-z\d]*);/gi, entity => {
    decoder.innerHTML = entity;
    return decoder.value;
  });

  const title = plainText(heading.tokens)
    .replace(/%%[\s\S]*?%%/g, "")
    .replace(/!?\[\[([^\]\n]+)\]\]/g, (_, target) => target.split("|").at(-1));
  const textContent = decodeEntities(title).replace(/\s+/g, " ").trim();
  return textContent ? { text: textContent, level: heading.depth } : null;
}

export function prependHeading(text, title) {
  const [prefix] = MARKDOWN_PREFIX.exec(text);
  const body = text.slice(prefix.length);
  const newline = text.includes("\r\n") ? "\r\n" : "\n";
  const afterFrontmatter = prefix.length > 1 && !prefix.endsWith("\n") ? newline : "";
  // Escape characters that could turn part of a typed title into Markdown.
  const escapedTitle = title.replace(/[!"#$%&'()*+,./:;<=>?@[\\\]^_\x60{|}~-]/g, char => "\\" + char);
  return prefix + afterFrontmatter + "# " + escapedTitle + (body ? newline + newline + body : "");
}
