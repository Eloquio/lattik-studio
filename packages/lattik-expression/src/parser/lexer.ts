/**
 * Tokenizer for Lattik SQL expressions.
 */

export type TokenKind =
  // literals
  | "INTEGER"
  | "DECIMAL"
  | "STRING"
  // identifiers & keywords
  | "IDENT"
  | "AND"
  | "OR"
  | "NOT"
  | "IS"
  | "NULL"
  | "TRUE"
  | "FALSE"
  | "IN"
  | "BETWEEN"
  | "LIKE"
  | "CASE"
  | "WHEN"
  | "THEN"
  | "ELSE"
  | "END"
  | "CAST"
  | "AS"
  | "OVER"
  | "PARTITION"
  | "BY"
  | "ORDER"
  | "ASC"
  | "DESC"
  | "ROWS"
  | "RANGE"
  | "UNBOUNDED"
  | "PRECEDING"
  | "FOLLOWING"
  | "CURRENT"
  | "ROW"
  | "FILTER"
  | "WHERE"
  | "DISTINCT"
  | "NULLS"
  | "FIRST"
  | "LAST"
  // types (for CAST)
  | "STRING_TYPE"
  | "INT32_TYPE"
  | "INT64_TYPE"
  | "FLOAT_TYPE"
  | "DOUBLE_TYPE"
  | "BOOLEAN_TYPE"
  | "TIMESTAMP_TYPE"
  | "DATE_TYPE"
  | "JSON_TYPE"
  // operators
  | "PLUS"
  | "MINUS"
  | "STAR"
  | "SLASH"
  | "PERCENT"
  | "PIPE_PIPE"
  | "EQ"
  | "NEQ"
  | "LTGT"
  | "LT"
  | "LTE"
  | "GT"
  | "GTE"
  // delimiters
  | "LPAREN"
  | "RPAREN"
  | "COMMA"
  | "DOT"
  // end
  | "EOF";

export interface Token {
  kind: TokenKind;
  text: string;
  line: number;
  col: number;
}

const KEYWORDS: Record<string, TokenKind> = {
  AND: "AND",
  OR: "OR",
  NOT: "NOT",
  IS: "IS",
  NULL: "NULL",
  TRUE: "TRUE",
  FALSE: "FALSE",
  IN: "IN",
  BETWEEN: "BETWEEN",
  LIKE: "LIKE",
  CASE: "CASE",
  WHEN: "WHEN",
  THEN: "THEN",
  ELSE: "ELSE",
  END: "END",
  CAST: "CAST",
  AS: "AS",
  OVER: "OVER",
  PARTITION: "PARTITION",
  BY: "BY",
  ORDER: "ORDER",
  ASC: "ASC",
  DESC: "DESC",
  ROWS: "ROWS",
  RANGE: "RANGE",
  UNBOUNDED: "UNBOUNDED",
  PRECEDING: "PRECEDING",
  FOLLOWING: "FOLLOWING",
  CURRENT: "CURRENT",
  ROW: "ROW",
  FILTER: "FILTER",
  WHERE: "WHERE",
  DISTINCT: "DISTINCT",
  NULLS: "NULLS",
  FIRST: "FIRST",
  LAST: "LAST",
};

// Type keywords — only recognized after AS in CAST
const TYPE_KEYWORDS: Record<string, TokenKind> = {
  STRING: "STRING_TYPE",
  INT32: "INT32_TYPE",
  INT64: "INT64_TYPE",
  FLOAT: "FLOAT_TYPE",
  DOUBLE: "DOUBLE_TYPE",
  BOOLEAN: "BOOLEAN_TYPE",
  TIMESTAMP: "TIMESTAMP_TYPE",
  DATE: "DATE_TYPE",
  JSON: "JSON_TYPE",
};

export interface LexError {
  line: number;
  col: number;
  message: string;
}

export interface LexResult {
  tokens: Token[];
  errors: LexError[];
}

/** Maximum input length accepted by the tokenizer (1MB). */
export const MAX_INPUT_LENGTH = 1_048_576;

/** Maximum length for a single numeric literal. */
const MAX_LITERAL_LENGTH = 100;

/** Maximum length for a single string literal or identifier. */
const MAX_STRING_LENGTH = 65_536;

export function tokenize(input: string): LexResult {
  if (input.length > MAX_INPUT_LENGTH) {
    return {
      tokens: [{ kind: "EOF", text: "", line: 1, col: 1 }],
      errors: [{ line: 1, col: 1, message: `Input too large (${input.length} chars, max ${MAX_INPUT_LENGTH})` }],
    };
  }

  const tokens: Token[] = [];
  const errors: LexError[] = [];
  let pos = 0;
  let line = 1;
  let col = 1;
  // Track whether the last meaningful token was AS (for CAST type keywords)
  let lastKind: TokenKind | null = null;

  function peek(): string {
    return pos < input.length ? input[pos] : "\0";
  }

  function advance(): string {
    const ch = input[pos];
    pos++;
    if (ch === "\n") {
      line++;
      col = 1;
    } else {
      col++;
    }
    return ch;
  }

  function emit(kind: TokenKind, text: string, startLine: number, startCol: number) {
    tokens.push({ kind, text, line: startLine, col: startCol });
    lastKind = kind;
  }

  while (pos < input.length) {
    const startLine = line;
    const startCol = col;
    const ch = peek();

    // Whitespace
    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") {
      advance();
      continue;
    }

    // Single-line comment: -- ...
    if (ch === "-" && pos + 1 < input.length && input[pos + 1] === "-") {
      while (pos < input.length && peek() !== "\n") advance();
      continue;
    }

    // Numbers
    if (ch >= "0" && ch <= "9") {
      let num = "";
      while (pos < input.length && peek() >= "0" && peek() <= "9") {
        num += advance();
      }
      if (pos < input.length && peek() === "." && pos + 1 < input.length && input[pos + 1] >= "0" && input[pos + 1] <= "9") {
        num += advance(); // '.'
        while (pos < input.length && peek() >= "0" && peek() <= "9") {
          num += advance();
        }
        if (num.length > MAX_LITERAL_LENGTH) {
          errors.push({ line: startLine, col: startCol, message: `Numeric literal too long (${num.length} chars, max ${MAX_LITERAL_LENGTH})` });
        }
        emit("DECIMAL", num, startLine, startCol);
      } else {
        if (num.length > MAX_LITERAL_LENGTH) {
          errors.push({ line: startLine, col: startCol, message: `Numeric literal too long (${num.length} chars, max ${MAX_LITERAL_LENGTH})` });
        }
        emit("INTEGER", num, startLine, startCol);
      }
      continue;
    }

    // String literal: 'hello' with '' escape
    if (ch === "'") {
      advance(); // opening '
      let str = "";
      let terminated = false;
      let truncated = false;
      while (pos < input.length) {
        if (peek() === "'") {
          advance();
          if (peek() === "'") {
            str += "'";
            advance();
          } else {
            terminated = true;
            break;
          }
        } else {
          if (str.length < MAX_STRING_LENGTH) {
            str += advance();
          } else {
            advance(); // consume but don't append
            truncated = true;
          }
        }
      }
      if (!terminated) {
        errors.push({ line: startLine, col: startCol, message: "Unterminated string literal" });
      }
      if (truncated) {
        errors.push({ line: startLine, col: startCol, message: `String literal too long (max ${MAX_STRING_LENGTH} chars)` });
      }
      emit("STRING", str, startLine, startCol);
      continue;
    }

    // Identifiers and keywords
    if ((ch >= "a" && ch <= "z") || (ch >= "A" && ch <= "Z") || ch === "_") {
      let ident = "";
      while (
        pos < input.length &&
        ((peek() >= "a" && peek() <= "z") ||
          (peek() >= "A" && peek() <= "Z") ||
          (peek() >= "0" && peek() <= "9") ||
          peek() === "_")
      ) {
        ident += advance();
      }
      const upper = ident.toUpperCase();

      // After AS keyword, recognize type keywords
      if (lastKind === "AS" && TYPE_KEYWORDS[upper]) {
        emit(TYPE_KEYWORDS[upper], ident, startLine, startCol);
      } else if (KEYWORDS[upper]) {
        emit(KEYWORDS[upper], ident, startLine, startCol);
      } else if (TYPE_KEYWORDS[upper]) {
        // Type keywords can also be used as identifiers in non-CAST context
        emit("IDENT", ident, startLine, startCol);
      } else {
        emit("IDENT", ident, startLine, startCol);
      }
      continue;
    }

    // Quoted identifier: "my column"
    if (ch === '"') {
      advance(); // opening "
      let ident = "";
      let truncated = false;
      while (pos < input.length && peek() !== '"') {
        if (ident.length < MAX_STRING_LENGTH) {
          ident += advance();
        } else {
          advance();
          truncated = true;
        }
      }
      if (pos < input.length) {
        advance(); // closing "
      } else {
        errors.push({ line: startLine, col: startCol, message: "Unterminated quoted identifier" });
      }
      if (truncated) {
        errors.push({ line: startLine, col: startCol, message: `Quoted identifier too long (max ${MAX_STRING_LENGTH} chars)` });
      }
      emit("IDENT", ident, startLine, startCol);
      continue;
    }

    // Operators and delimiters
    switch (ch) {
      case "+":
        advance();
        emit("PLUS", "+", startLine, startCol);
        continue;
      case "-":
        advance();
        emit("MINUS", "-", startLine, startCol);
        continue;
      case "*":
        advance();
        emit("STAR", "*", startLine, startCol);
        continue;
      case "/":
        advance();
        emit("SLASH", "/", startLine, startCol);
        continue;
      case "%":
        advance();
        emit("PERCENT", "%", startLine, startCol);
        continue;
      case "(":
        advance();
        emit("LPAREN", "(", startLine, startCol);
        continue;
      case ")":
        advance();
        emit("RPAREN", ")", startLine, startCol);
        continue;
      case ",":
        advance();
        emit("COMMA", ",", startLine, startCol);
        continue;
      case ".":
        advance();
        emit("DOT", ".", startLine, startCol);
        continue;
      case "=":
        advance();
        emit("EQ", "=", startLine, startCol);
        continue;
      case "<":
        advance();
        if (peek() === "=") {
          advance();
          emit("LTE", "<=", startLine, startCol);
        } else if (peek() === ">") {
          advance();
          emit("LTGT", "<>", startLine, startCol);
        } else {
          emit("LT", "<", startLine, startCol);
        }
        continue;
      case ">":
        advance();
        if (peek() === "=") {
          advance();
          emit("GTE", ">=", startLine, startCol);
        } else {
          emit("GT", ">", startLine, startCol);
        }
        continue;
      case "!":
        advance();
        if (peek() === "=") {
          advance();
          emit("NEQ", "!=", startLine, startCol);
        } else {
          errors.push({ line: startLine, col: startCol, message: `Unexpected character '!'` });
        }
        continue;
      case "|":
        advance();
        if (peek() === "|") {
          advance();
          emit("PIPE_PIPE", "||", startLine, startCol);
        } else {
          errors.push({ line: startLine, col: startCol, message: `Unexpected character '|'` });
        }
        continue;
      default:
        advance();
        errors.push({ line: startLine, col: startCol, message: `Unexpected character '${ch}'` });
        continue;
    }
  }

  emit("EOF", "", line, col);
  return { tokens, errors };
}
