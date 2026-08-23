// csv.ts - a bounded RFC 4180 reader for customer CRM exports.
//
// Zero dependencies, like the rest of the repository's tooling. It is deliberately strict: an
// unterminated quote is an error rather than a silently truncated record, because a truncated
// record would import as a real opportunity with missing money.

const MAX_COLUMNS = 200;

export interface CsvTable {
  readonly columns: readonly string[];
  readonly records: readonly Readonly<Record<string, string>>[];
}

export function parseCsv(text: string, maxRows = 5000): CsvTable {
  const rows = parseRows(text);
  if (rows.length === 0) throw new Error("crm_import_csv_empty");
  const header = rows[0]!.map((cell) => cell.trim());
  if (header.length > MAX_COLUMNS) throw new Error("crm_import_csv_too_many_columns");
  if (header.some((cell) => cell === "")) throw new Error("crm_import_csv_blank_header");
  const seen = new Set<string>();
  for (const cell of header) {
    const key = cell.toLowerCase();
    if (seen.has(key)) throw new Error(`crm_import_csv_duplicate_column:${cell}`);
    seen.add(key);
  }

  const body = rows.slice(1).filter((cells) => cells.some((cell) => cell.trim() !== ""));
  if (body.length > maxRows) throw new Error("crm_import_csv_too_many_rows");

  const records = body.map((cells) => {
    if (cells.length > header.length) throw new Error("crm_import_csv_row_wider_than_header");
    const record: Record<string, string> = {};
    header.forEach((column, index) => {
      record[column] = (cells[index] ?? "").trim();
    });
    return record;
  });

  return { columns: header, records };
}

function parseRows(text: string): string[][] {
  const rows: string[][] = [];
  let cells: string[] = [];
  let cell = "";
  let quoted = false;
  // Strip a UTF-8 BOM: spreadsheet exports carry one and it would poison the first column name.
  const input = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;

  for (let i = 0; i < input.length; i++) {
    const ch = input[i]!;
    if (quoted) {
      if (ch !== '"') { cell += ch; continue; }
      if (input[i + 1] === '"') { cell += '"'; i++; continue; }
      quoted = false;
      continue;
    }
    if (ch === '"') { quoted = true; continue; }
    if (ch === ",") { cells.push(cell); cell = ""; continue; }
    if (ch === "\r") continue;
    if (ch === "\n") { cells.push(cell); rows.push(cells); cells = []; cell = ""; continue; }
    cell += ch;
  }
  if (quoted) throw new Error("crm_import_csv_unterminated_quote");
  if (cell !== "" || cells.length > 0) { cells.push(cell); rows.push(cells); }
  return rows;
}
