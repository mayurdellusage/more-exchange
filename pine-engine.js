/**
 * pine-engine.js - High-Performance Clean-Room Pine Script Execution Engine & Web Worker
 *
 * Part of More Exchange - Decentralized / Local Crypto Simulator
 * License: MIT (Permissive Open-Source, 100% Free for GitHub Pages & Commercial Use)
 *
 * Features:
 * - Full Pine Script parser & tokenizer for v5/v6 indicators and strategies
 * - Exact mathematical algorithms for EMA, SMA, RSI, MACD, ATR, Crossover, Crossunder
 * - Strict syntax & argument arity validation with line and column diagnostics
 * - State variables (var, :=), history indexing (series[k]), and user inputs
 * - Broker emulator with FIFO lot tracking, next-bar fills, same-bar SL/TP bracket exits
 * - Zero-copy transferable Float64Array typed memory architecture
 * - Asynchronous job protocol with progress dispatch, cancellation, and stale-result rejection
 */

/* global self, postMessage, importScripts */

(function(){
  "use strict";

  // --------------------------------------------------------------------------
  // 1. AST Tokenizer & Parser
  // --------------------------------------------------------------------------
  const TOKEN_TYPES = {
    KEYWORD: "KEYWORD",
    IDENTIFIER: "IDENTIFIER",
    NUMBER: "NUMBER",
    STRING: "STRING",
    OPERATOR: "OPERATOR",
    PUNCTUATION: "PUNCTUATION",
    NEWLINE: "NEWLINE",
    EOF: "EOF"
  };

  const KEYWORDS = new Set([
    "indicator", "strategy", "if", "else", "for", "while", "to", "by",
    "var", "varip", "true", "false", "and", "or", "not"
  ]);

  function tokenize(source) {
    const tokens = [];
    let i = 0;
    let line = 1;
    let col = 1;
    const len = source.length;

    while (i < len) {
      const ch = source[i];

      // Comment
      if (ch === '/' && source[i + 1] === '/') {
        while (i < len && source[i] !== '\n') { i++; col++; }
        continue;
      }

      // Whitespace (except newline)
      if (ch === ' ' || ch === '\t' || ch === '\r') {
        i++;
        col++;
        continue;
      }

      // Newline
      if (ch === '\n') {
        tokens.push({ type: TOKEN_TYPES.NEWLINE, value: '\n', line, col });
        i++;
        line++;
        col = 1;
        continue;
      }

      // Numbers
      if (/[0-9]/.test(ch) || (ch === '.' && /[0-9]/.test(source[i + 1] || ''))) {
        const startCol = col;
        let numStr = "";
        let hasDot = false;
        while (i < len && (/[0-9]/.test(source[i]) || (source[i] === '.' && !hasDot))) {
          if (source[i] === '.') hasDot = true;
          numStr += source[i];
          i++;
          col++;
        }
        tokens.push({ type: TOKEN_TYPES.NUMBER, value: parseFloat(numStr), raw: numStr, line, col: startCol });
        continue;
      }

      // Strings
      if (ch === '"' || ch === "'") {
        const quote = ch;
        const startCol = col;
        let strVal = "";
        i++;
        col++;
        while (i < len && source[i] !== quote && source[i] !== '\n') {
          if (source[i] === '\\' && i + 1 < len) {
            i++;
            col++;
            strVal += source[i];
          } else {
            strVal += source[i];
          }
          i++;
          col++;
        }
        if (i < len && source[i] === quote) {
          i++;
          col++;
        }
        tokens.push({ type: TOKEN_TYPES.STRING, value: strVal, line, col: startCol });
        continue;
      }

      // Arrow operator =>
      if (source.slice(i, i + 2) === "=>") {
        tokens.push({ type: TOKEN_TYPES.OPERATOR, value: "=>", line, col });
        i += 2;
        col += 2;
        continue;
      }

      // Compound Operators: :=, +=, -=, *=, /=, ==, !=, <=, >=
      const op2 = source.slice(i, i + 2);
      if (op2 === ":=" || op2 === "+=" || op2 === "-=" || op2 === "*=" || op2 === "/=" ||
          op2 === "==" || op2 === "!=" || op2 === "<=" || op2 === ">=") {
        tokens.push({ type: TOKEN_TYPES.OPERATOR, value: op2, line, col });
        i += 2;
        col += 2;
        continue;
      }

      // Single Operators
      if ("=+-*/%<>?:".includes(ch)) {
        tokens.push({ type: TOKEN_TYPES.OPERATOR, value: ch, line, col });
        i++;
        col++;
        continue;
      }

      // Punctuation: ( ) [ ] ,
      if ("()[],".includes(ch)) {
        tokens.push({ type: TOKEN_TYPES.PUNCTUATION, value: ch, line, col });
        i++;
        col++;
        continue;
      }

      // Identifiers / Keywords / Dotted Identifiers (e.g. ta.ema, strategy.entry)
      if (/[a-zA-Z_]/.test(ch)) {
        const startCol = col;
        let idStr = "";
        while (i < len && /[a-zA-Z0-9_.]/.test(source[i])) {
          idStr += source[i];
          i++;
          col++;
        }
        if (KEYWORDS.has(idStr)) {
          tokens.push({ type: TOKEN_TYPES.KEYWORD, value: idStr, line, col: startCol });
        } else {
          tokens.push({ type: TOKEN_TYPES.IDENTIFIER, value: idStr, line, col: startCol });
        }
        continue;
      }

      // Unknown character fallback
      i++;
      col++;
    }

    tokens.push({ type: TOKEN_TYPES.EOF, value: "", line, col });
    return tokens;
  }

  // --------------------------------------------------------------------------
  // 2. Built-in Function Signatures & Arity Validation Metadata
  // --------------------------------------------------------------------------
  const FUNCTION_SIGNATURES = {
    // Technical Analysis
    "ta.ema": { minArgs: 2, maxArgs: 2, desc: "(source, length)" },
    "ta.sma": { minArgs: 2, maxArgs: 2, desc: "(source, length)" },
    "ta.wma": { minArgs: 2, maxArgs: 2, desc: "(source, length)" },
    "ta.vwma": { minArgs: 2, maxArgs: 2, desc: "(source, length)" },
    "ta.rsi": { minArgs: 2, maxArgs: 2, desc: "(source, length)" },
    "ta.macd": { minArgs: 4, maxArgs: 4, desc: "(source, fastlen, slowlen, siglen)" },
    "ta.atr": { minArgs: 1, maxArgs: 1, desc: "(length)" },
    "ta.crossover": { minArgs: 2, maxArgs: 2, desc: "(source1, source2)" },
    "ta.crossunder": { minArgs: 2, maxArgs: 2, desc: "(source1, source2)" },
    "ta.highest": { minArgs: 2, maxArgs: 2, desc: "(source, length)" },
    "ta.lowest": { minArgs: 2, maxArgs: 2, desc: "(source, length)" },
    "ta.highestbars": { minArgs: 2, maxArgs: 2, desc: "(source, length)" },
    "ta.lowestbars": { minArgs: 2, maxArgs: 2, desc: "(source, length)" },
    "ta.valuewhen": { minArgs: 2, maxArgs: 3, desc: "(condition, source, occurrence?)" },
    "ta.change": { minArgs: 1, maxArgs: 2, desc: "(source, length?)" },
    "ta.cum": { minArgs: 1, maxArgs: 1, desc: "(source)" },
    "ta.barssince": { minArgs: 1, maxArgs: 1, desc: "(condition)" },
    "ta.bb": { minArgs: 2, maxArgs: 3, desc: "(source, length, mult?)" },
    "ta.dmi": { minArgs: 2, maxArgs: 2, desc: "(diLength, adxSmoothing)" },

    // Math
    "math.abs": { minArgs: 1, maxArgs: 1, desc: "(number)" },
    "math.max": { minArgs: 2, maxArgs: 10, desc: "(n1, n2, ...)" },
    "math.min": { minArgs: 2, maxArgs: 10, desc: "(n1, n2, ...)" },
    "math.round": { minArgs: 1, maxArgs: 2, desc: "(number, precision?)" },
    "math.floor": { minArgs: 1, maxArgs: 1, desc: "(number)" },
    "math.ceil": { minArgs: 1, maxArgs: 1, desc: "(number)" },
    "math.sqrt": { minArgs: 1, maxArgs: 1, desc: "(number)" },
    "math.pow": { minArgs: 2, maxArgs: 2, desc: "(base, exp)" },
    "math.sign": { minArgs: 1, maxArgs: 1, desc: "(number)" },
    "math.log": { minArgs: 1, maxArgs: 1, desc: "(number)" },
    "math.exp": { minArgs: 1, maxArgs: 1, desc: "(number)" },

    // Helpers & Plots
    "nz": { minArgs: 1, maxArgs: 2, desc: "(source, replacement?)" },
    "na": { minArgs: 1, maxArgs: 1, desc: "(source)" },
    "plot": { minArgs: 1, maxArgs: 8, desc: "(series, title?, color?, linewidth?, style?)" },
    "color.new": { minArgs: 2, maxArgs: 2, desc: "(color, transp)" },

    // Inputs
    "input": { minArgs: 1, maxArgs: 5, desc: "(defval, title?)" },
    "input.int": { minArgs: 1, maxArgs: 6, desc: "(defval, title?, minval?, maxval?, step?)" },
    "input.float": { minArgs: 1, maxArgs: 6, desc: "(defval, title?, minval?, maxval?, step?)" },
    "input.bool": { minArgs: 1, maxArgs: 3, desc: "(defval, title?)" },
    "input.string": { minArgs: 1, maxArgs: 4, desc: "(defval, title?, options?)" },
    "input.source": { minArgs: 1, maxArgs: 3, desc: "(defval, title?)" },
    "input.color": { minArgs: 1, maxArgs: 3, desc: "(defval, title?)" },

    // Strategy
    "strategy.entry": { minArgs: 2, maxArgs: 8, desc: "(id, direction, qty?, limit?, stop?, when?)" },
    "strategy.close": { minArgs: 1, maxArgs: 3, desc: "(id, when?, comment?)" },
    "strategy.exit": { minArgs: 1, maxArgs: 10, desc: "(id, from_entry?, profit?, loss?, limit?, stop?, when?)" },
    "strategy.cancel": { minArgs: 1, maxArgs: 1, desc: "(id)" },
    "strategy.cancel_all": { minArgs: 0, maxArgs: 0, desc: "()" },
    "strategy.close_all": { minArgs: 0, maxArgs: 2, desc: "(when?, comment?)" }
  };

  const PINE_TYPES = new Set(["float", "int", "bool", "string", "color"]);

  const BUILTIN_SERIES = new Set([
    "open", "high", "low", "close", "volume", "time", "bar_index", "hl2", "hlc3", "ohlc4",
    "strategy.position_size", "strategy.position_avg_price", "strategy.closedtrades",
    "strategy.opentrades", "strategy.netprofit", "strategy.equity", "strategy.openprofit",
    "strategy.initial_capital"
  ]);

  const BUILTIN_CONSTANTS = new Set([
    "true", "false", "na", "strategy.long", "strategy.short",
    "strategy.percent_of_equity", "strategy.fixed", "strategy.cash",
    "strategy.commission.percent", "strategy.commission.cash_per_contract", "strategy.commission.cash_per_order",
    "color.blue", "color.red", "color.green", "color.white", "color.yellow", "color.purple", "color.orange", "color.gray",
    "color.black", "color.teal", "color.navy", "color.maroon", "color.olive", "color.silver", "color.lime", "color.aqua", "color.fuchsia"
  ]);

  // --------------------------------------------------------------------------
  // 3. Recursive-Descent AST Parser & Syntax Diagnostics (Phase 6 Foundation)
  // --------------------------------------------------------------------------
  class PineParser {
    constructor(tokens) {
      this.tokens = tokens;
      this.pos = 0;
      this.errors = [];
      this.declaredVars = new Set([...BUILTIN_SERIES, ...BUILTIN_CONSTANTS]);
    }

    current() {
      return this.tokens[this.pos] || { type: TOKEN_TYPES.EOF, value: "", line: 1, col: 1 };
    }

    peek(offset = 1) {
      return this.tokens[this.pos + offset] || { type: TOKEN_TYPES.EOF, value: "", line: 1, col: 1 };
    }

    isAtEnd() {
      return this.pos >= this.tokens.length || this.current().type === TOKEN_TYPES.EOF;
    }

    advance() {
      const tok = this.current();
      if (!this.isAtEnd()) this.pos++;
      return tok;
    }

    match(expectedValue) {
      if (this.current().value === expectedValue) {
        return this.advance();
      }
      return null;
    }

    consumeNewlines() {
      while (this.current().type === TOKEN_TYPES.NEWLINE) {
        this.advance();
      }
    }

    addError(message, token = null) {
      const tok = token || this.current();
      this.errors.push({
        line: tok.line,
        column: tok.col,
        message
      });
    }

    // Program entry point
    parse() {
      this.consumeNewlines();
      const body = [];
      let scriptType = null;
      let scriptHeader = null;

      let firstStatement = true;
      while (!this.isAtEnd()) {
        const loopStart = this.pos;
        this.consumeNewlines();
        if (this.isAtEnd()) break;

        const tok = this.current();

        // Reject unsupported features explicitly
        if (tok.value === "for") {
          this.addError("Loops ('for') are not supported in this version.", tok);
          this.advance();
          this.skipToNextLine();
          continue;
        }
        if (tok.value === "while") {
          this.addError("Loops ('while') are not supported in this version.", tok);
          this.advance();
          this.skipToNextLine();
          continue;
        }

        const stmt = this.parseStatement();
        if (stmt) {
          if (firstStatement) {
            firstStatement = false;
            if (stmt.type === "ExpressionStatement" && stmt.expression && stmt.expression.type === "CallExpression") {
              const callee = stmt.expression.callee.name;
              if (callee === "indicator" || callee === "strategy") {
                scriptType = callee;
                scriptHeader = stmt;
              }
            }
            if (!scriptType) {
              this.addError("Script must declare either indicator(...) or strategy(...) on the first active statement.", tok);
            }
          }
          body.push(stmt);
        } else {
          this.skipToNextLine();
        }

        if (this.pos === loopStart) {
          this.advance();
        }
      }

      if (!scriptType) {
        this.addError("Script must declare either indicator(...) or strategy(...).", { line: 1, col: 1 });
      }

      return {
        type: "Program",
        scriptType,
        header: scriptHeader,
        body,
        errors: this.errors
      };
    }

    skipToNextLine() {
      while (!this.isAtEnd() && this.current().type !== TOKEN_TYPES.NEWLINE) {
        this.advance();
      }
      this.consumeNewlines();
    }

    parseStatement() {
      const tok = this.current();

      // Check for user-defined function definition f(x) => ...
      if (tok.type === TOKEN_TYPES.IDENTIFIER && this.peek(1).value === "(") {
        let look = this.pos + 2;
        let depth = 1;
        while (look < this.tokens.length && depth > 0 && this.tokens[look].type !== TOKEN_TYPES.NEWLINE) {
          if (this.tokens[look].value === "(") depth++;
          else if (this.tokens[look].value === ")") depth--;
          look++;
        }
        if (look < this.tokens.length && this.tokens[look].value === "=>") {
          return this.parseFunctionDeclaration();
        }
      }

      // Check for multi-timeframe request.*
      if (tok.value && tok.value.startsWith("request.")) {
        this.addError("Multi-timeframe requests ('request.*') are not supported in this version.", tok);
        this.skipToNextLine();
        return null;
      }

      // 1. Variable declaration: var / varip [type] name = expr
      if (tok.value === "var" || tok.value === "varip") {
        const isVarip = tok.value === "varip";
        const varTok = this.advance();
        let varType = null;
        if (this.current().type === TOKEN_TYPES.IDENTIFIER && PINE_TYPES.has(this.current().value)) {
          varType = this.advance().value;
        }
        const idTok = this.current();
        if (idTok.type !== TOKEN_TYPES.IDENTIFIER) {
          this.addError(`Expected variable identifier after '${varTok.value}${varType ? ' ' + varType : ''}', got '${idTok.value}'`, idTok);
          this.skipToNextLine();
          return null;
        }
        this.advance();
        this.declaredVars.add(idTok.value);

        if (!this.match("=")) {
          this.addError(`Expected '=' in variable declaration for '${idTok.value}'`, this.current());
          this.skipToNextLine();
          return null;
        }

        const init = this.parseExpression();
        return {
          type: "Declaration",
          name: idTok.value,
          varType,
          isVar: true,
          isVarip,
          init,
          loc: { line: varTok.line, col: varTok.col }
        };
      }

      // Non-var typed declaration: float x = expr, int y = expr, bool b = expr, string s = expr
      if (tok.type === TOKEN_TYPES.IDENTIFIER && PINE_TYPES.has(tok.value) && this.peek(1).type === TOKEN_TYPES.IDENTIFIER) {
        const typeTok = this.advance();
        const idTok = this.advance();
        this.declaredVars.add(idTok.value);
        if (!this.match("=")) {
          this.addError(`Expected '=' in variable declaration for '${idTok.value}'`, this.current());
          this.skipToNextLine();
          return null;
        }
        const init = this.parseExpression();
        return {
          type: "Declaration",
          name: idTok.value,
          varType: typeTok.value,
          isVar: false,
          isVarip: false,
          init,
          loc: { line: typeTok.line, col: typeTok.col }
        };
      }

      // 2. Tuple declaration: [a, b, c] = expr
      if (tok.value === "[") {
        const startTok = this.advance();
        const names = [];
        while (!this.isAtEnd() && this.current().value !== "]") {
          const loopStart = this.pos;
          const item = this.current();
          if (item.type === TOKEN_TYPES.IDENTIFIER) {
            names.push(item.value);
            this.declaredVars.add(item.value);
            this.advance();
          } else if (item.value === ",") {
            this.advance();
          } else {
            this.addError(`Unexpected token in tuple declaration: '${item.value}'`, item);
            break;
          }
          if (this.pos === loopStart) this.advance();
        }
        this.match("]");
        if (!this.match("=")) {
          this.addError("Expected '=' after tuple declaration", this.current());
          this.skipToNextLine();
          return null;
        }
        const init = this.parseExpression();
        return {
          type: "TupleDeclaration",
          names,
          init,
          loc: { line: startTok.line, col: startTok.col }
        };
      }

      // 3. Reassignment (:=, +=, -=, *=, /=) or Simple Declaration (name = expr)
      if (tok.type === TOKEN_TYPES.IDENTIFIER) {
        const next = this.peek(1);
        if (next.value === "=") {
          const idTok = this.advance();
          this.advance(); // consume '='
          this.declaredVars.add(idTok.value);
          const init = this.parseExpression();
          return {
            type: "Declaration",
            name: idTok.value,
            isVar: false,
            isVarip: false,
            init,
            loc: { line: idTok.line, col: idTok.col }
          };
        } else if (next.value === ":=" || next.value === "+=" || next.value === "-=" || next.value === "*=" || next.value === "/=") {
          const idTok = this.advance();
          const opTok = this.advance();
          if (!this.declaredVars.has(idTok.value)) {
            this.addError(`Cannot reassign undeclared identifier '${idTok.value}'`, idTok);
          }
          const val = this.parseExpression();
          return {
            type: "Reassignment",
            name: idTok.value,
            operator: opTok.value,
            value: val,
            loc: { line: idTok.line, col: idTok.col }
          };
        }
      }

      // 4. Conditional statement: if cond ... [else ...]
      if (tok.value === "if") {
        return this.parseIfStatement();
      }

      // 5. Expression Statement (e.g. function calls, plot, strategy.entry)
      const expr = this.parseExpression();
      if (expr) {
        return {
          type: "ExpressionStatement",
          expression: expr,
          loc: expr.loc
        };
      }

      return null;
    }

    parseFunctionDeclaration() {
      const fnTok = this.advance(); // consume function name
      const fnCol = fnTok.col;
      this.advance(); // consume '('

      const params = [];
      const newlyDeclared = [];
      while (!this.isAtEnd() && this.current().value !== ")") {
        const pTok = this.current();
        if (pTok.type === TOKEN_TYPES.IDENTIFIER) {
          this.advance();
          let defaultVal = null;
          if (this.current().value === "=") {
            this.advance();
            defaultVal = this.parseExpression();
          }
          params.push({ name: pTok.value, defaultVal });
          if (!this.declaredVars.has(pTok.value)) {
            this.declaredVars.add(pTok.value);
            newlyDeclared.push(pTok.value);
          }
        } else if (pTok.value === ",") {
          this.advance();
        } else {
          this.addError(`Unexpected token in function parameters: '${pTok.value}'`, pTok);
          break;
        }
      }
      this.match(")");
      this.match("=>");
      this.declaredVars.add(fnTok.value);

      let fnResult;
      // Check if body is multi-line indented block or single-line expression
      if (this.current().type === TOKEN_TYPES.NEWLINE) {
        this.consumeNewlines();

        const bodyStatements = [];
        while (!this.isAtEnd() && this.current().type !== TOKEN_TYPES.EOF) {
          const loopStart = this.pos;
          if (this.current().type === TOKEN_TYPES.NEWLINE) {
            this.advance();
            continue;
          }
          if (this.current().col <= fnCol) {
            break;
          }
          const stmt = this.parseStatement();
          if (stmt) bodyStatements.push(stmt);
          else this.skipToNextLine();

          if (this.pos === loopStart) this.advance();
        }
        fnResult = {
          type: "FunctionDeclaration",
          name: fnTok.value,
          params,
          body: bodyStatements,
          isBlock: true,
          loc: { line: fnTok.line, col: fnTok.col }
        };
      } else {
        const bodyExpr = this.parseExpression();
        fnResult = {
          type: "FunctionDeclaration",
          name: fnTok.value,
          params,
          body: bodyExpr,
          isBlock: false,
          loc: { line: fnTok.line, col: fnTok.col }
        };
      }

      for (const p of newlyDeclared) {
        this.declaredVars.delete(p);
      }
      return fnResult;
    }

    parseIfStatement() {
      const ifTok = this.advance(); // consume 'if'
      const ifCol = ifTok.col;

      let cond;
      if (this.current().value === "(") {
        this.advance();
        cond = this.parseExpression();
        if (!this.match(")")) {
          this.addError("Expected ')' after if condition", this.current());
        }
      } else {
        cond = this.parseExpression();
      }

      const consequent = [];
      let alternate = null;

      // Check if body is on next line indented or same line
      if (this.current().type === TOKEN_TYPES.NEWLINE) {
        this.consumeNewlines();
        while (!this.isAtEnd() && this.current().type !== TOKEN_TYPES.EOF) {
          const loopStart = this.pos;
          if (this.current().type === TOKEN_TYPES.NEWLINE) {
            this.advance();
            continue;
          }
          if (this.current().col <= ifCol) {
            break; // End of indented block
          }
          const stmt = this.parseStatement();
          if (stmt) consequent.push(stmt);
          else this.skipToNextLine();

          if (this.pos === loopStart) this.advance();
        }

        // Check for 'else' at same indentation level
        if (this.current().value === "else" && this.current().col === ifCol) {
          this.advance(); // consume 'else'
          alternate = [];
          if (this.current().type === TOKEN_TYPES.NEWLINE) {
            this.consumeNewlines();
            while (!this.isAtEnd() && this.current().type !== TOKEN_TYPES.EOF) {
              const loopStart = this.pos;
              if (this.current().type === TOKEN_TYPES.NEWLINE) {
                this.advance();
                continue;
              }
              if (this.current().col <= ifCol) break;
              const stmt = this.parseStatement();
              if (stmt) alternate.push(stmt);
              else this.skipToNextLine();

              if (this.pos === loopStart) this.advance();
            }
          } else {
            const singleStmt = this.parseStatement();
            if (singleStmt) alternate.push(singleStmt);
          }
        }
      } else {
        const stmt = this.parseStatement();
        if (stmt) consequent.push(stmt);
      }

      return {
        type: "IfStatement",
        condition: cond,
        consequent,
        alternate,
        loc: { line: ifTok.line, col: ifTok.col }
      };
    }

    // ------------------------------------------------------------------------
    // Expression Parsing with Proper Precedence
    // ------------------------------------------------------------------------
    parseExpression() {
      return this.parseTernary();
    }

    parseTernary() {
      const expr = this.parseLogicalOr();
      if (this.current().value === "?") {
        const qTok = this.advance();
        const consequent = this.parseTernary();
        if (!this.match(":")) {
          this.addError("Expected ':' in ternary expression", this.current());
        }
        const alternate = this.parseTernary();
        return {
          type: "TernaryExpression",
          test: expr,
          consequent,
          alternate,
          loc: expr ? expr.loc : { line: qTok.line, col: qTok.col }
        };
      }
      return expr;
    }

    parseLogicalOr() {
      let left = this.parseLogicalAnd();
      while (this.current().value === "or") {
        const opTok = this.advance();
        const right = this.parseLogicalAnd();
        left = {
          type: "BinaryExpression",
          operator: "or",
          left,
          right,
          loc: left ? left.loc : { line: opTok.line, col: opTok.col }
        };
      }
      return left;
    }

    parseLogicalAnd() {
      let left = this.parseEquality();
      while (this.current().value === "and") {
        const opTok = this.advance();
        const right = this.parseEquality();
        left = {
          type: "BinaryExpression",
          operator: "and",
          left,
          right,
          loc: left ? left.loc : { line: opTok.line, col: opTok.col }
        };
      }
      return left;
    }

    parseEquality() {
      let left = this.parseComparison();
      while (this.current().value === "==" || this.current().value === "!=") {
        const opTok = this.advance();
        const right = this.parseComparison();
        left = {
          type: "BinaryExpression",
          operator: opTok.value,
          left,
          right,
          loc: left ? left.loc : { line: opTok.line, col: opTok.col }
        };
      }
      return left;
    }

    parseComparison() {
      let left = this.parseAdditive();
      while (this.current().value === "<" || this.current().value === "<=" ||
             this.current().value === ">" || this.current().value === ">=") {
        const opTok = this.advance();
        const right = this.parseAdditive();
        left = {
          type: "BinaryExpression",
          operator: opTok.value,
          left,
          right,
          loc: left ? left.loc : { line: opTok.line, col: opTok.col }
        };
      }
      return left;
    }

    parseAdditive() {
      let left = this.parseMultiplicative();
      while (this.current().value === "+" || this.current().value === "-") {
        const opTok = this.advance();
        const right = this.parseMultiplicative();
        left = {
          type: "BinaryExpression",
          operator: opTok.value,
          left,
          right,
          loc: left ? left.loc : { line: opTok.line, col: opTok.col }
        };
      }
      return left;
    }

    parseMultiplicative() {
      let left = this.parseUnary();
      while (this.current().value === "*" || this.current().value === "/" || this.current().value === "%") {
        const opTok = this.advance();
        const right = this.parseUnary();
        left = {
          type: "BinaryExpression",
          operator: opTok.value,
          left,
          right,
          loc: left ? left.loc : { line: opTok.line, col: opTok.col }
        };
      }
      return left;
    }

    parseUnary() {
      if (this.current().value === "-" || this.current().value === "+" || this.current().value === "not") {
        const opTok = this.advance();
        const arg = this.parseUnary();
        return {
          type: "UnaryExpression",
          operator: opTok.value,
          argument: arg,
          prefix: true,
          loc: { line: opTok.line, col: opTok.col }
        };
      }
      return this.parsePrimary();
    }

    parsePrimary() {
      const tok = this.current();

      // Literals: Number
      if (tok.type === TOKEN_TYPES.NUMBER) {
        this.advance();
        return {
          type: "Literal",
          value: tok.value,
          raw: tok.raw,
          loc: { line: tok.line, col: tok.col }
        };
      }

      // Literals: String
      if (tok.type === TOKEN_TYPES.STRING) {
        this.advance();
        return {
          type: "Literal",
          value: tok.value,
          raw: tok.value,
          loc: { line: tok.line, col: tok.col }
        };
      }

      // Literals: Booleans & na (only when not followed by '(' call syntax)
      const nextTok = this.tokens[this.pos + 1];
      if (tok.value === "true" || tok.value === "false" || (tok.value === "na" && (!nextTok || nextTok.value !== "("))) {
        this.advance();
        return {
          type: "Literal",
          value: tok.value === "true" ? true : (tok.value === "false" ? false : NaN),
          raw: tok.value,
          loc: { line: tok.line, col: tok.col }
        };
      }

      // Parentheses: ( expr )
      if (tok.value === "(") {
        const startTok = this.advance();
        const expr = this.parseExpression();
        if (!this.match(")")) {
          this.addError("Syntax error: Unmatched parentheses '(' and ')'.", startTok);
        }
        return expr;
      }

      // Identifiers / Calls / History Indexing
      if (tok.type === TOKEN_TYPES.IDENTIFIER || tok.type === TOKEN_TYPES.KEYWORD) {
        const idTok = this.advance();
        const idName = idTok.value;

        // Function call: name(...)
        if (this.current().value === "(") {
          return this.parseCall(idTok);
        }

        // History indexing: name[k]
        if (this.current().value === "[") {
          this.advance(); // consume '['
          const idxTok = this.current();
          let indexVal = 0;
          if (idxTok.type === TOKEN_TYPES.NUMBER) {
            indexVal = idxTok.value;
            this.advance();
          } else {
            const idxExpr = this.parseExpression();
            indexVal = idxExpr;
          }
          if (!this.match("]")) {
            this.addError("Expected ']' in history indexing", this.current());
          }
          return {
            type: "HistoryIndexExpression",
            series: { type: "Identifier", name: idName, loc: { line: idTok.line, col: idTok.col } },
            index: indexVal,
            loc: { line: idTok.line, col: idTok.col }
          };
        }

        // Undeclared identifier validation
        if (!this.declaredVars.has(idName) && !FUNCTION_SIGNATURES[idName]) {
          this.addError(`Undeclared identifier '${idName}'.`, idTok);
        }

        return {
          type: "Identifier",
          name: idName,
          loc: { line: idTok.line, col: idTok.col }
        };
      }

      this.addError(`Unexpected token '${tok.value}'`, tok);
      this.advance();
      return null;
    }

    parseCall(idTok) {
      const calleeName = idTok.value;
      const parenTok = this.advance(); // consume '('
      const args = [];

      let rawArgCount = 0;
      while (!this.isAtEnd() && this.current().value !== ")") {
        const loopStartPos = this.pos;
        this.consumeNewlines();
        if (this.current().value === ")") break;

        // Named argument check: name = expr
        if (this.current().type === TOKEN_TYPES.IDENTIFIER && this.peek(1).value === "=" && this.peek(1).type === TOKEN_TYPES.OPERATOR) {
          const argNameTok = this.advance();
          this.advance(); // consume '='
          const argVal = this.parseExpression();
          args.push({
            type: "NamedArgument",
            name: argNameTok.value,
            value: argVal,
            loc: { line: argNameTok.line, col: argNameTok.col }
          });
          rawArgCount++;
        } else {
          const argVal = this.parseExpression();
          if (argVal) {
            args.push(argVal);
            rawArgCount++;
          }
        }

        if (this.current().value === ",") {
          this.advance();
        } else if (this.current().value !== ")") {
          this.consumeNewlines();
        }

        if (this.pos === loopStartPos) {
          this.addError(`Unexpected token '${this.current().value}' in argument list`, this.current());
          this.advance();
        }
      }

      if (!this.match(")")) {
        this.addError("Syntax error: Unmatched parentheses '(' and ')'.", parenTok);
      }

      // Built-in Function Signature & Arity Validation
      const sig = FUNCTION_SIGNATURES[calleeName];
      if (calleeName.startsWith("request.")) {
        this.addError("Multi-timeframe requests ('request.*') are not supported in this version.", idTok);
      } else if (calleeName.startsWith("array.")) {
        this.addError("Array operations ('array.*') are not supported in this version.", idTok);
      } else if (calleeName.startsWith("matrix.")) {
        this.addError("Matrix operations ('matrix.*') are not supported in this version.", idTok);
      } else if (sig) {
        if (rawArgCount < sig.minArgs) {
          this.addError(`Function '${calleeName}' expects at least ${sig.minArgs} argument(s) ${sig.desc}, but received ${rawArgCount}.`, idTok);
        } else if (sig.maxArgs && rawArgCount > sig.maxArgs) {
          this.addError(`Function '${calleeName}' expects at most ${sig.maxArgs} argument(s) ${sig.desc}, but received ${rawArgCount}.`, idTok);
        }
      } else if (calleeName.startsWith("ta.") || calleeName.startsWith("math.") || calleeName.startsWith("strategy.")) {
        this.addError(`Unknown or unsupported namespace member '${calleeName}'.`, idTok);
      }

      return {
        type: "CallExpression",
        callee: { type: "Identifier", name: calleeName, loc: { line: idTok.line, col: idTok.col } },
        args,
        loc: { line: idTok.line, col: idTok.col }
      };
    }
  }

  function parsePine(source) {
    const tokens = tokenize(source);
    const parser = new PineParser(tokens);
    const ast = parser.parse();
    return {
      ast,
      isValid: ast.errors.length === 0,
      errors: ast.errors
    };
  }

  function validateScript(source) {
    const p = parsePine(source);
    return {
      isValid: p.isValid,
      errors: p.errors,
      ast: p.ast
    };
  }

  // --------------------------------------------------------------------------
  // 4. Vectorized Technical Analysis Math Core (Typed Array O(N))
  // --------------------------------------------------------------------------
  function calcEMA(source, length) {
    const N = source.length;
    const out = new Float64Array(N);
    if (N === 0) return out;
    const alpha = 2.0 / (length + 1.0);
    out[0] = source[0];
    for (let i = 1; i < N; i++) {
      out[i] = alpha * source[i] + (1.0 - alpha) * out[i - 1];
    }
    return out;
  }

  function calcSMA(source, length) {
    const N = source.length;
    const out = new Float64Array(N);
    out.fill(NaN);
    if (N < length) return out;

    let windowSum = 0;
    for (let i = 0; i < length; i++) windowSum += source[i];
    out[length - 1] = windowSum / length;

    for (let i = length; i < N; i++) {
      windowSum += source[i] - source[i - length];
      out[i] = windowSum / length;
    }
    return out;
  }

  function calcWMA(source, length) {
    const N = source.length;
    const out = new Float64Array(N);
    out.fill(NaN);
    if (N < length) return out;
    const norm = (length * (length + 1)) / 2;
    for (let i = length - 1; i < N; i++) {
      let sum = 0;
      for (let j = 0; j < length; j++) {
        sum += source[i - j] * (length - j);
      }
      out[i] = sum / norm;
    }
    return out;
  }

  function calcVWMA(source, volumes, length) {
    const N = source.length;
    const out = new Float64Array(N);
    out.fill(NaN);
    if (N < length) return out;
    const pv = new Float64Array(N);
    for (let i = 0; i < N; i++) pv[i] = source[i] * volumes[i];
    const num = calcSMA(pv, length);
    const den = calcSMA(volumes, length);
    for (let i = length - 1; i < N; i++) {
      out[i] = den[i] !== 0 ? num[i] / den[i] : NaN;
    }
    return out;
  }

  function calcRMA(source, length) {
    const N = source.length;
    const out = new Float64Array(N);
    out.fill(NaN);
    if (N < length) return out;

    let sum = 0;
    for (let i = 0; i < length; i++) sum += source[i];
    out[length - 1] = sum / length;
    const alpha = 1.0 / length;

    for (let i = length; i < N; i++) {
      out[i] = alpha * source[i] + (1.0 - alpha) * out[i - 1];
    }
    return out;
  }

  function calcRSI(source, length) {
    const N = source.length;
    const out = new Float64Array(N);
    out.fill(NaN);
    if (N <= length) return out;

    const gains = new Float64Array(N);
    const losses = new Float64Array(N);
    for (let i = 1; i < N; i++) {
      const diff = source[i] - source[i - 1];
      if (diff > 0) gains[i] = diff;
      else losses[i] = -diff;
    }

    const avgGain = calcRMA(gains.subarray(1), length);
    const avgLoss = calcRMA(losses.subarray(1), length);

    for (let i = length; i < N; i++) {
      const g = avgGain[i - 1];
      const l = avgLoss[i - 1];
      if (!isNaN(g) && !isNaN(l)) {
        if (l === 0) out[i] = 100;
        else {
          const rs = g / l;
          out[i] = 100 - (100 / (1 + rs));
        }
      }
    }
    return out;
  }

  function calcATR(highs, lows, closes, length) {
    const N = highs.length;
    const tr = new Float64Array(N);
    tr[0] = highs[0] - lows[0];
    for (let i = 1; i < N; i++) {
      tr[i] = Math.max(
        highs[i] - lows[i],
        Math.abs(highs[i] - closes[i - 1]),
        Math.abs(lows[i] - closes[i - 1])
      );
    }
    return calcRMA(tr, length);
  }

  function calcHighest(source, length) {
    const N = source.length;
    const out = new Float64Array(N);
    for (let i = 0; i < N; i++) {
      const start = Math.max(0, i - length + 1);
      let maxVal = source[start];
      for (let k = start + 1; k <= i; k++) {
        if (source[k] > maxVal) maxVal = source[k];
      }
      out[i] = maxVal;
    }
    return out;
  }

  function calcLowest(source, length) {
    const N = source.length;
    const out = new Float64Array(N);
    for (let i = 0; i < N; i++) {
      const start = Math.max(0, i - length + 1);
      let minVal = source[start];
      for (let k = start + 1; k <= i; k++) {
        if (source[k] < minVal) minVal = source[k];
      }
      out[i] = minVal;
    }
    return out;
  }

  function calcHighestBars(source, length) {
    const N = source.length;
    const out = new Float64Array(N);
    out.fill(NaN);
    if (N < length) return out;
    for (let i = length - 1; i < N; i++) {
      let maxVal = -Infinity;
      let maxOffset = 0;
      for (let j = 0; j < length; j++) {
        const val = source[i - j];
        if (!isNaN(val) && val > maxVal) {
          maxVal = val;
          maxOffset = -j;
        }
      }
      out[i] = maxOffset;
    }
    return out;
  }

  function calcLowestBars(source, length) {
    const N = source.length;
    const out = new Float64Array(N);
    out.fill(NaN);
    if (N < length) return out;
    for (let i = length - 1; i < N; i++) {
      let minVal = Infinity;
      let minOffset = 0;
      for (let j = 0; j < length; j++) {
        const val = source[i - j];
        if (!isNaN(val) && val < minVal) {
          minVal = val;
          minOffset = -j;
        }
      }
      out[i] = minOffset;
    }
    return out;
  }

  function calcStdev(source, length) {
    const N = source.length;
    const out = new Float64Array(N);
    out.fill(NaN);
    if (N < length) return out;
    const sma = calcSMA(source, length);
    for (let i = length - 1; i < N; i++) {
      let sumSq = 0;
      const mean = sma[i];
      for (let k = i - length + 1; k <= i; k++) {
        const d = source[k] - mean;
        sumSq += d * d;
      }
      out[i] = Math.sqrt(sumSq / length);
    }
    return out;
  }

  function calcBollingerBands(source, length, mult) {
    const basis = calcSMA(source, length);
    const dev = calcStdev(source, length);
    const N = source.length;
    const upper = new Float64Array(N);
    const lower = new Float64Array(N);
    for (let i = 0; i < N; i++) {
      if (isNaN(basis[i]) || isNaN(dev[i])) {
        upper[i] = NaN;
        lower[i] = NaN;
      } else {
        upper[i] = basis[i] + dev[i] * mult;
        lower[i] = basis[i] - dev[i] * mult;
      }
    }
    return { basis, upper, lower };
  }

  function calcMACD(source, fastLen, slowLen, sigLen) {
    const fastEMA = calcEMA(source, fastLen);
    const slowEMA = calcEMA(source, slowLen);
    const N = source.length;
    const macdLine = new Float64Array(N);
    for (let i = 0; i < N; i++) {
      macdLine[i] = fastEMA[i] - slowEMA[i];
    }
    const signalLine = calcEMA(macdLine, sigLen);
    const histLine = new Float64Array(N);
    for (let i = 0; i < N; i++) {
      histLine[i] = macdLine[i] - signalLine[i];
    }
    return { macdLine, signalLine, histLine };
  }

  function calcDMI(highs, lows, closes, diLength, adxSmoothing) {
    const N = closes.length;
    const diPlus = new Float64Array(N);
    const diMinus = new Float64Array(N);
    const adx = new Float64Array(N);
    diPlus.fill(NaN);
    diMinus.fill(NaN);
    adx.fill(NaN);

    if (N < diLength) return { diPlus, diMinus, adx };

    const tr = new Float64Array(N);
    const plusDM = new Float64Array(N);
    const minusDM = new Float64Array(N);

    tr[0] = highs[0] - lows[0];
    plusDM[0] = 0;
    minusDM[0] = 0;

    for (let i = 1; i < N; i++) {
      const h = highs[i];
      const l = lows[i];
      const prevC = closes[i - 1];
      const prevH = highs[i - 1];
      const prevL = lows[i - 1];

      tr[i] = Math.max(h - l, Math.abs(h - prevC), Math.abs(l - prevC));

      const up = h - prevH;
      const down = prevL - l;

      plusDM[i] = (up > down && up > 0) ? up : 0;
      minusDM[i] = (down > up && down > 0) ? down : 0;
    }

    const sTR = calcRMA(tr, diLength);
    const sPlusDM = calcRMA(plusDM, diLength);
    const sMinusDM = calcRMA(minusDM, diLength);

    const dx = new Float64Array(N);
    dx.fill(NaN);

    for (let i = 0; i < N; i++) {
      if (isNaN(sTR[i]) || sTR[i] === 0) {
        diPlus[i] = NaN;
        diMinus[i] = NaN;
      } else {
        const dp = 100.0 * (sPlusDM[i] / sTR[i]);
        const dm = 100.0 * (sMinusDM[i] / sTR[i]);
        diPlus[i] = dp;
        diMinus[i] = dm;
        const sum = dp + dm;
        dx[i] = sum === 0 ? 0 : 100.0 * (Math.abs(dp - dm) / sum);
      }
    }

    const validStart = diLength - 1;
    if (N >= validStart + adxSmoothing) {
      const adxRaw = calcRMA(dx.subarray(validStart), adxSmoothing);
      for (let j = 0; j < adxRaw.length; j++) {
        adx[validStart + j] = adxRaw[j];
      }
    }

    return { diPlus, diMinus, adx };
  }

  // --------------------------------------------------------------------------
  // 5. Execution Runtime & Broker Emulator (AST-Based Clean Room Engine)
  // --------------------------------------------------------------------------

  // Helper to extract argument by positional index or parameter name
  function getArgValue(args, paramName, positionalIndex = -1, defaultVal = null) {
    if (!args || !args.length) return defaultVal;
    if (paramName) {
      for (const a of args) {
        if (a && a.type === "NamedArgument" && a.name === paramName) {
          return a.value;
        }
      }
    }
    if (typeof positionalIndex === "number" && positionalIndex >= 0 && positionalIndex < args.length) {
      const a = args[positionalIndex];
      if (a && a.type === "NamedArgument") {
        if (!paramName || a.name === paramName) return a.value;
      } else if (a && a.type !== "NamedArgument") {
        return a;
      }
    }
    return defaultVal;
  }

  // Recursive AST Expression Evaluator for a specific bar index with lexical scoping and recursion limits
  function evaluateExpression(node, i, env, callDepth = 0) {
    if (!node) return null;
    if (callDepth > 15) {
      throw new Error(`Pine Script maximum recursion depth exceeded (limit: 15)`);
    }

    switch (node.type) {
      case "Literal":
        return node.value;

      case "Identifier": {
        const name = node.name;

        // Function-local variables / parameters shadow outer scope (Lexical Scoping)
        if (env.localVars && env.localVars.has(name)) {
          return env.localVars.get(name);
        }

        if (name === "bar_index") return i;
        if (name === "time") return env.dataset.times[i];
        if (name === "open") return env.dataset.opens[i];
        if (name === "high") return env.dataset.highs[i];
        if (name === "low") return env.dataset.lows[i];
        if (name === "close") return env.dataset.closes[i];
        if (name === "volume") return env.dataset.volumes[i];
        if (name === "true") return true;
        if (name === "false") return false;
        if (name === "na") return NaN;

        // Pine Strategy Built-in Constants & State
        if (name === "strategy.long") return "LONG";
        if (name === "strategy.short") return "SHORT";
        if (name === "strategy.percent_of_equity") return "percent_of_equity";
        if (name === "strategy.fixed") return "fixed";
        if (name === "strategy.cash") return "cash";
        if (name === "strategy.commission.percent") return "percent";
        if (name === "strategy.commission.cash_per_contract") return "cash_per_contract";
        if (name === "strategy.commission.cash_per_order") return "cash_per_order";
        if (name === "strategy.closedtrades") {
          return env.state.closedtrades != null ? env.state.closedtrades : (env.strategySeries && env.strategySeries["strategy.closedtrades"] ? env.strategySeries["strategy.closedtrades"][i] : 0);
        }
        if (name === "strategy.opentrades") {
          return env.state.position ? 1 : 0;
        }
        if (name === "strategy.initial_capital") {
          return env.strategyConfig ? env.strategyConfig.initialCapital : env.state.initialCapital;
        }
        if (name === "color.blue") return "#2962ff";
        if (name === "color.red") return "#f23645";
        if (name === "color.green") return "#089981";
        if (name === "color.white") return "#ffffff";
        if (name === "color.yellow") return "#fbc02d";
        if (name === "color.purple") return "#9c27b0";
        if (name === "color.orange") return "#ff9800";
        if (name === "color.gray") return "#787b86";
        if (name === "color.black") return "#000000";

        if (name === "strategy.position_size") {
          if (!env.state.position) return 0;
          return env.state.position.side === "LONG" ? env.state.position.qty : -env.state.position.qty;
        }
        if (name === "strategy.position_avg_price") {
          return env.state.position ? env.state.position.entryPrice : NaN;
        }
        if (name === "strategy.equity") {
          let eq = env.state.capital;
          if (env.state.position) {
            const curP = env.dataset.closes[i];
            const pnl = env.state.position.side === "LONG"
              ? (curP - env.state.position.entryPrice) * env.state.position.qty
              : (env.state.position.entryPrice - curP) * env.state.position.qty;
            eq += pnl;
          }
          return eq;
        }
        if (name === "strategy.netprofit") {
          return env.state.capital - env.state.initialCapital;
        }
        if (name === "strategy.openprofit") {
          if (!env.state.position) return 0;
          const curP = env.dataset.closes[i];
          return env.state.position.side === "LONG"
            ? (curP - env.state.position.entryPrice) * env.state.position.qty
            : (env.state.position.entryPrice - curP) * env.state.position.qty;
        }

        // User inputs
        if (env.inputs && env.inputs[name] !== undefined) {
          return env.inputs[name];
        }

        // Variables evaluated during runtime
        if (env.vars.has(name)) {
          const v = env.vars.get(name);
          if (v instanceof Float64Array || Array.isArray(v)) {
            return v[i];
          }
          return v;
        }

        // Pre-computed indicator series
        if (env.series.has(name)) {
          return env.series.get(name)[i];
        }

        return NaN;
      }

      case "BinaryExpression": {
        const left = evaluateExpression(node.left, i, env, callDepth);
        const right = evaluateExpression(node.right, i, env, callDepth);
        switch (node.operator) {
          case "+": return left + right;
          case "-": return left - right;
          case "*": return left * right;
          case "/": return right === 0 ? NaN : left / right;
          case "%": return right === 0 ? NaN : left % right;
          case "==": return left === right;
          case "!=": return left !== right;
          case "<": return left < right;
          case "<=": return left <= right;
          case ">": return left > right;
          case ">=": return left >= right;
          case "and": return Boolean(left) && Boolean(right);
          case "or": return Boolean(left) || Boolean(right);
          default: return NaN;
        }
      }

      case "UnaryExpression": {
        const val = evaluateExpression(node.argument, i, env, callDepth);
        switch (node.operator) {
          case "-": return -val;
          case "+": return +val;
          case "!":
          case "not": return !val;
          default: return val;
        }
      }

      case "TernaryExpression": {
        const cond = evaluateExpression(node.test, i, env, callDepth);
        return cond ? evaluateExpression(node.consequent, i, env, callDepth) : evaluateExpression(node.alternate, i, env, callDepth);
      }

      case "HistoryIndexExpression": {
        let targetSeries = null;
        if (node.series && node.series.type === "Identifier") {
          const sName = node.series.name;
          if (env.strategySeries && env.strategySeries[sName]) {
            targetSeries = env.strategySeries[sName];
          } else if (env.localSeries && env.localSeries.has(sName)) {
            targetSeries = env.localSeries.get(sName);
          } else if (env.localVars && env.localVars.has(sName)) {
            const lv = env.localVars.get(sName);
            if (lv instanceof Float64Array || Array.isArray(lv)) targetSeries = lv;
            else return NaN;
          } else if (sName === "open") targetSeries = env.dataset.opens;
          else if (sName === "high") targetSeries = env.dataset.highs;
          else if (sName === "low") targetSeries = env.dataset.lows;
          else if (sName === "close") targetSeries = env.dataset.closes;
          else if (sName === "volume") targetSeries = env.dataset.volumes;
          else if (env.series.has(sName)) targetSeries = env.series.get(sName);
          else if (env.vars.has(sName)) targetSeries = env.vars.get(sName);
        } else if (node.series) {
          targetSeries = evaluateExpression(node.series, i, env, callDepth);
        }

        const offsetVal = typeof node.index === "number" ? node.index : evaluateExpression(node.index, i, env, callDepth);
        const k = Math.round(Number(offsetVal) || 0);
        const targetIdx = i - k;

        if (targetSeries && (targetSeries instanceof Float64Array || Array.isArray(targetSeries))) {
          if (targetIdx >= 0 && targetIdx < targetSeries.length) {
            return targetSeries[targetIdx];
          }
          if (node.series && (node.series.name === "strategy.closedtrades" || node.series.name === "strategy.opentrades")) {
            return 0;
          }
          return NaN;
        }
        return NaN;
      }

      case "CallExpression": {
        // Pre-computed vector indicator lookup
        if (node._seriesKey && env.series.has(node._seriesKey)) {
          return env.series.get(node._seriesKey)[i];
        }

        const callee = node.callee ? node.callee.name : "";

        if (callee === "color.new") {
          const c = evaluateExpression(node.args[0], i, env, callDepth);
          return typeof c === "string" ? c : "#787b86";
        }

        // User-Defined Function Call
        if (env.functions && env.functions.has(callee)) {
          if (callDepth >= 15) {
            throw new Error(`Pine Script maximum recursion depth exceeded (limit: 15) in function '${callee}'`);
          }
          const fnNode = env.functions.get(callee);
          const localScope = new Map();
          const localSeries = new Map();

          // Parameter binding with default value fallback and named argument resolution
          for (let pIdx = 0; pIdx < fnNode.params.length; pIdx++) {
            const param = fnNode.params[pIdx];
            let argVal = undefined;
            let passedArgNode = null;

            // 1. First check if a NamedArgument was passed matching this param name
            const matchNamed = node.args ? node.args.find(a => a && a.type === "NamedArgument" && a.name === param.name) : null;
            if (matchNamed) {
              passedArgNode = matchNamed.value;
              argVal = evaluateExpression(matchNamed.value, i, env, callDepth + 1);
            } else if (node.args && pIdx < node.args.length && node.args[pIdx] && node.args[pIdx].type !== "NamedArgument") {
              passedArgNode = node.args[pIdx];
              argVal = evaluateExpression(node.args[pIdx], i, env, callDepth + 1);
            } else if (param.defaultVal) {
              passedArgNode = param.defaultVal;
              argVal = evaluateExpression(param.defaultVal, i, env, callDepth + 1);
            }
            localScope.set(param.name, argVal !== undefined ? argVal : NaN);

            // If argument references a known series vector, bind it to localSeries for history indexing
            if (passedArgNode && passedArgNode.type === "Identifier") {
              const aName = passedArgNode.name;
              let sRef = null;
              if (aName === "open") sRef = env.dataset.opens;
              else if (aName === "high") sRef = env.dataset.highs;
              else if (aName === "low") sRef = env.dataset.lows;
              else if (aName === "close") sRef = env.dataset.closes;
              else if (aName === "volume") sRef = env.dataset.volumes;
              else if (env.localSeries && env.localSeries.has(aName)) sRef = env.localSeries.get(aName);
              else if (env.series && env.series.has(aName)) sRef = env.series.get(aName);
              else if (env.vars && env.vars.has(aName)) sRef = env.vars.get(aName);

              if (sRef) {
                localSeries.set(param.name, sRef);
              }
            }
          }

          const localEnv = Object.assign({}, env, {
            localVars: localScope,
            localSeries: localSeries,
            parentEnv: env
          });

          if (fnNode.isBlock) {
            let result = NaN;
            for (const stmt of fnNode.body) {
              if (!stmt) continue;
              if (stmt.type === "Declaration") {
                const val = evaluateExpression(stmt.init, i, localEnv, callDepth + 1);
                localScope.set(stmt.name, val);
                result = val;
              } else if (stmt.type === "Reassignment") {
                const val = evaluateExpression(stmt.value, i, localEnv, callDepth + 1);
                let cur = localScope.has(stmt.name) ? localScope.get(stmt.name) : 0;
                if (stmt.operator === ":=") cur = val;
                else if (stmt.operator === "+=") cur += val;
                else if (stmt.operator === "-=") cur -= val;
                else if (stmt.operator === "*=") cur *= val;
                else if (stmt.operator === "/=") cur /= val;
                localScope.set(stmt.name, cur);
                result = cur;
              } else if (stmt.type === "ExpressionStatement") {
                result = evaluateExpression(stmt.expression, i, localEnv, callDepth + 1);
              } else if (stmt.type === "IfStatement") {
                const cond = evaluateExpression(stmt.condition, i, localEnv, callDepth + 1);
                const branch = cond ? stmt.consequent : stmt.alternate;
                if (branch) {
                  for (const s of branch) {
                    if (s.type === "ExpressionStatement") {
                      result = evaluateExpression(s.expression, i, localEnv, callDepth + 1);
                    } else if (s.type === "Declaration") {
                      const v = evaluateExpression(s.init, i, localEnv, callDepth + 1);
                      localScope.set(s.name, v);
                      result = v;
                    } else if (s.type === "Reassignment") {
                      const v = evaluateExpression(s.value, i, localEnv, callDepth + 1);
                      let cur = localScope.has(s.name) ? localScope.get(s.name) : 0;
                      if (s.operator === ":=") cur = v;
                      else if (s.operator === "+=") cur += v;
                      else if (s.operator === "-=") cur -= v;
                      else if (s.operator === "*=") cur *= v;
                      else if (s.operator === "/=") cur /= v;
                      localScope.set(s.name, cur);
                      result = cur;
                    }
                  }
                }
              }
            }
            return result;
          } else {
            return evaluateExpression(fnNode.body, i, localEnv, callDepth + 1);
          }
        }

        if (callee === "ta.crossover") {
          const aCur = evaluateExpression(node.args[0], i, env, callDepth);
          const bCur = evaluateExpression(node.args[1], i, env, callDepth);
          const aPrev = i > 0 ? evaluateExpression(node.args[0], i - 1, env, callDepth) : NaN;
          const bPrev = i > 0 ? evaluateExpression(node.args[1], i - 1, env, callDepth) : NaN;
          return (!isNaN(aCur) && !isNaN(bCur) && !isNaN(aPrev) && !isNaN(bPrev)) && (aCur > bCur && aPrev <= bPrev);
        }
        if (callee === "ta.crossunder") {
          const aCur = evaluateExpression(node.args[0], i, env, callDepth);
          const bCur = evaluateExpression(node.args[1], i, env, callDepth);
          const aPrev = i > 0 ? evaluateExpression(node.args[0], i - 1, env, callDepth) : NaN;
          const bPrev = i > 0 ? evaluateExpression(node.args[1], i - 1, env, callDepth) : NaN;
          return (!isNaN(aCur) && !isNaN(bCur) && !isNaN(aPrev) && !isNaN(bPrev)) && (aCur < bCur && aPrev >= bPrev);
        }
        if (callee === "ta.change") {
          const aCur = evaluateExpression(node.args[0], i, env, callDepth);
          const aPrev = i > 0 ? evaluateExpression(node.args[0], i - 1, env, callDepth) : NaN;
          return aCur - aPrev;
        }
        if (callee === "ta.highestbars") {
          const srcArg = node.args[0];
          const lenArg = node.args[1];
          const len = lenArg ? Math.round(Number(evaluateExpression(lenArg, i, env, callDepth)) || 14) : 14;
          if (i < len - 1) return NaN;
          let maxVal = -Infinity;
          let maxOffset = 0;
          for (let j = 0; j < len; j++) {
            const val = evaluateExpression(srcArg, i - j, env, callDepth);
            if (!isNaN(val) && val > maxVal) {
              maxVal = val;
              maxOffset = -j;
            }
          }
          return maxOffset;
        }
        if (callee === "ta.lowestbars") {
          const srcArg = node.args[0];
          const lenArg = node.args[1];
          const len = lenArg ? Math.round(Number(evaluateExpression(lenArg, i, env, callDepth)) || 14) : 14;
          if (i < len - 1) return NaN;
          let minVal = Infinity;
          let minOffset = 0;
          for (let j = 0; j < len; j++) {
            const val = evaluateExpression(srcArg, i - j, env, callDepth);
            if (!isNaN(val) && val < minVal) {
              minVal = val;
              minOffset = -j;
            }
          }
          return minOffset;
        }
        if (callee === "ta.valuewhen") {
          const condArg = node.args[0];
          const srcArg = node.args[1];
          const occArg = node.args[2];
          const targetOcc = occArg ? Math.round(Number(evaluateExpression(occArg, i, env, callDepth)) || 0) : 0;
          if (targetOcc < 0) return NaN;
          let foundCount = 0;
          for (let bar = i; bar >= 0; bar--) {
            const isCondTrue = Boolean(evaluateExpression(condArg, bar, env, callDepth));
            if (isCondTrue) {
              if (foundCount === targetOcc) {
                return evaluateExpression(srcArg, bar, env, callDepth);
              }
              foundCount++;
            }
          }
          return NaN;
        }
        if (callee === "math.abs") return Math.abs(evaluateExpression(node.args[0], i, env, callDepth));
        if (callee === "math.max") return Math.max(evaluateExpression(node.args[0], i, env, callDepth), evaluateExpression(node.args[1], i, env, callDepth));
        if (callee === "math.min") return Math.min(evaluateExpression(node.args[0], i, env, callDepth), evaluateExpression(node.args[1], i, env, callDepth));
        if (callee === "math.round") return Math.round(evaluateExpression(node.args[0], i, env, callDepth));
        if (callee === "math.floor") return Math.floor(evaluateExpression(node.args[0], i, env, callDepth));
        if (callee === "math.ceil") return Math.ceil(evaluateExpression(node.args[0], i, env, callDepth));
        if (callee === "math.sqrt") return Math.sqrt(evaluateExpression(node.args[0], i, env, callDepth));
        if (callee === "math.pow") return Math.pow(evaluateExpression(node.args[0], i, env, callDepth), evaluateExpression(node.args[1], i, env, callDepth));
        if (callee === "math.sign") return Math.sign(evaluateExpression(node.args[0], i, env, callDepth));
        if (callee === "math.log") return Math.log(evaluateExpression(node.args[0], i, env, callDepth));
        if (callee === "math.exp") return Math.exp(evaluateExpression(node.args[0], i, env, callDepth));
        if (callee === "na") {
          const v = evaluateExpression(node.args[0], i, env, callDepth);
          return isNaN(v) || v === null || v === undefined;
        }
        if (callee === "nz") {
          const v = evaluateExpression(node.args[0], i, env, callDepth);
          const def = node.args[1] ? evaluateExpression(node.args[1], i, env, callDepth) : 0;
          return (isNaN(v) || v === null || v === undefined) ? def : v;
        }

        return NaN;
      }

      default:
        return NaN;
    }
  }

  // Pre-Scan and Vectorize AST Declarations, Inputs, and Indicators
  function preScanAndVectorize(ast, dataset, callerOptions, env) {
    const { opens, highs, lows, closes, volumes } = dataset;
    const N = closes.length;

    // Built-in standard series
    env.series.set("open", opens);
    env.series.set("high", highs);
    env.series.set("low", lows);
    env.series.set("close", closes);
    env.series.set("volume", volumes);

    const hl2 = new Float64Array(N);
    const hlc3 = new Float64Array(N);
    const ohlc4 = new Float64Array(N);
    for (let i = 0; i < N; i++) {
      hl2[i] = (highs[i] + lows[i]) * 0.5;
      hlc3[i] = (highs[i] + lows[i] + closes[i]) / 3.0;
      ohlc4[i] = (opens[i] + highs[i] + lows[i] + closes[i]) * 0.25;
    }
    env.series.set("hl2", hl2);
    env.series.set("hlc3", hlc3);
    env.series.set("ohlc4", ohlc4);

    let anonId = 1;

    // Helper to evaluate a call node into a full series vector
    function computeCallSeries(callNode) {
      const callee = callNode.callee ? callNode.callee.name : "";
      const rawArgs = callNode.args || [];

      // Resolve source series argument (default to closes)
      let srcSeries = closes;
      let lenArgIndex = 1;
      if (callee === "ta.atr") {
        lenArgIndex = 0;
      }

      if (rawArgs.length > 0 && lenArgIndex === 1) {
        const firstArg = rawArgs[0];
        if (firstArg.type === "Identifier") {
          srcSeries = env.series.get(firstArg.name) || (firstArg.name === "high" ? highs : (firstArg.name === "low" ? lows : closes));
        }
      }

      function resolveArg(paramName, posIndex, fallback) {
        if (paramName) {
          for (const a of rawArgs) {
            if (a && a.type === "NamedArgument" && a.name === paramName) {
              const vNode = a.value;
              if (vNode) {
                if (vNode.type === "Literal") return vNode.value;
                if (vNode.type === "Identifier") {
                  if (env.inputs[vNode.name] !== undefined) return env.inputs[vNode.name];
                  if (env.vars.has(vNode.name)) return env.vars.get(vNode.name);
                }
              }
            }
          }
        }
        if (typeof posIndex === "number" && posIndex >= 0 && posIndex < rawArgs.length) {
          const a = rawArgs[posIndex];
          if (a && a.type !== "NamedArgument") {
            if (a.type === "Literal") return a.value;
            if (a.type === "Identifier") {
              if (env.inputs[a.name] !== undefined) return env.inputs[a.name];
              if (env.vars.has(a.name)) return env.vars.get(a.name);
            }
          }
        }
        return fallback;
      }

      // Resolve length argument
      let length = Number(resolveArg("length", lenArgIndex, 14)) || 14;

      if (callee === "ta.ema") return calcEMA(srcSeries, length);
      if (callee === "ta.sma") return calcSMA(srcSeries, length);
      if (callee === "ta.wma") return calcWMA(srcSeries, length);
      if (callee === "ta.vwma") return calcVWMA(srcSeries, volumes, length);
      if (callee === "ta.rsi") return calcRSI(srcSeries, length);
      if (callee === "ta.atr") return calcATR(highs, lows, closes, length);
      if (callee === "ta.highest") return calcHighest(srcSeries, length);
      if (callee === "ta.lowest") return calcLowest(srcSeries, length);
      if (callee === "ta.highestbars") return calcHighestBars(srcSeries, length);
      if (callee === "ta.lowestbars") return calcLowestBars(srcSeries, length);
      if (callee === "ta.stdev") return calcStdev(srcSeries, length);
      if (callee === "ta.bb") {
        const bbLen = Number(resolveArg("length", 1, 20)) || 20;
        const bbMult = Number(resolveArg("mult", 2, 2.0)) || 2.0;
        return calcBollingerBands(srcSeries, bbLen, bbMult);
      }
      if (callee === "ta.dmi") {
        const diLen = Number(resolveArg("diLength", 0, 14)) || 14;
        const adxSmooth = Number(resolveArg("adxSmoothing", 1, 14)) || 14;
        return calcDMI(highs, lows, closes, diLen, adxSmooth);
      }
      if (callee === "ta.macd") {
        const fast = Number(resolveArg("fastlen", 1, 12)) || 12;
        const slow = Number(resolveArg("slowlen", 2, 26)) || 26;
        const sig = Number(resolveArg("siglen", 3, 9)) || 9;
        return calcMACD(srcSeries, fast, slow, sig);
      }
      return null;
    }

    // First Pass: Extract strategy/indicator declarations, inputs, and indicators
    for (const node of ast.body) {
      if (!node) continue;

      // Extract script/strategy declarations
      if (node.type === "ExpressionStatement" && node.expression && node.expression.type === "CallExpression") {
        const call = node.expression;
        const callee = call.callee ? call.callee.name : "";
        if (callee === "strategy") {
          const initCap = getArgValue(call.args, "initial_capital");
          if (initCap && initCap.type === "Literal" && typeof initCap.value === "number") {
            env.strategyConfig.initialCapital = initCap.value;
          }
          const pyr = getArgValue(call.args, "pyramiding");
          if (pyr && pyr.type === "Literal" && typeof pyr.value === "number") {
            env.strategyConfig.pyramiding = pyr.value;
          }
          const dQtyType = getArgValue(call.args, "default_qty_type");
          if (dQtyType) {
            env.strategyConfig.default_qty_type = (dQtyType.type === "Identifier" || dQtyType.type === "Literal") ? (dQtyType.value || dQtyType.name) : "strategy.percent_of_equity";
          }
          const dQtyVal = getArgValue(call.args, "default_qty_value");
          if (dQtyVal && dQtyVal.type === "Literal" && typeof dQtyVal.value === "number") {
            env.strategyConfig.default_qty_value = dQtyVal.value;
          }
          const commType = getArgValue(call.args, "commission_type");
          if (commType) {
            env.strategyConfig.commission_type = (commType.type === "Identifier" || commType.type === "Literal") ? (commType.value || commType.name) : "strategy.commission.percent";
          }
          const commVal = getArgValue(call.args, "commission_value");
          if (commVal && commVal.type === "Literal" && typeof commVal.value === "number") {
            env.strategyConfig.commission_value = commVal.value;
          }
          const slip = getArgValue(call.args, "slippage");
          if (slip && slip.type === "Literal" && typeof slip.value === "number") {
            env.strategyConfig.slippage = slip.value;
          }
        }
      }

      // Extract User Inputs & Declarations
      if (node.type === "Declaration") {
        const init = node.init;
        if (init && init.type === "CallExpression") {
          const callee = init.callee ? init.callee.name : "";
          if (callee.startsWith("input")) {
            const defValNode = getArgValue(init.args, "defval", 0);
            let defVal = defValNode && defValNode.type === "Literal" ? defValNode.value : 0;
            const titleNode = getArgValue(init.args, "title", 1);
            const title = titleNode && titleNode.type === "Literal" ? titleNode.value : node.name;

            // Caller option override
            if (callerOptions.inputs) {
              if (callerOptions.inputs[node.name] !== undefined) {
                defVal = callerOptions.inputs[node.name];
              } else if (callerOptions.inputs[title] !== undefined) {
                defVal = callerOptions.inputs[title];
              } else {
                const lowerName = node.name.toLowerCase();
                const lowerTitle = title.toLowerCase();
                for (const k of Object.keys(callerOptions.inputs)) {
                  const lk = k.toLowerCase();
                  if (lk === lowerName || lk === lowerTitle) {
                    defVal = callerOptions.inputs[k];
                    break;
                  }
                }
              }
            }
            env.inputs[node.name] = defVal;
            env.inputs[title] = defVal;
          } else if (callee.startsWith("ta.")) {
            const seriesVec = computeCallSeries(init);
            if (seriesVec) {
              env.series.set(node.name, seriesVec);
              init._seriesKey = node.name;
            }
          }
        }
      } else if (node.type === "TupleDeclaration") {
        const init = node.init;
        if (init && init.type === "CallExpression" && init.callee && init.callee.name.startsWith("ta.")) {
          const resObj = computeCallSeries(init);
          if (resObj && node.names && node.names.length >= 3) {
            if (resObj.macdLine) {
              env.series.set(node.names[0], resObj.macdLine);
              env.series.set(node.names[1], resObj.signalLine);
              env.series.set(node.names[2], resObj.histLine);
            } else if (resObj.basis) {
              env.series.set(node.names[0], resObj.basis);
              env.series.set(node.names[1], resObj.upper);
              env.series.set(node.names[2], resObj.lower);
            } else if (resObj.diPlus) {
              env.series.set(node.names[0], resObj.diPlus);
              env.series.set(node.names[1], resObj.diMinus);
              env.series.set(node.names[2], resObj.adx);
            }
          }
        }
      }
    }

    // Second Pass: Pre-compute any nested technical indicators in expressions
    function walkAndPrecompute(n) {
      if (!n || typeof n !== "object") return;
      if (n.type === "CallExpression" && n.callee && n.callee.name && n.callee.name.startsWith("ta.")) {
        const sVec = computeCallSeries(n);
        if (sVec && sVec instanceof Float64Array) {
          const anonKey = `_ta_anon_${anonId++}`;
          env.series.set(anonKey, sVec);
          n._seriesKey = anonKey;
        }
      }
      for (const k of Object.keys(n)) {
        if (k === "loc") continue;
        const child = n[k];
        if (Array.isArray(child)) {
          for (const item of child) walkAndPrecompute(item);
        } else if (child && typeof child === "object") {
          walkAndPrecompute(child);
        }
      }
    }
    for (const stmt of ast.body) {
      walkAndPrecompute(stmt);
    }
  }

  // --------------------------------------------------------------------------
  // Performance Analytics & Metrics Engine
  // --------------------------------------------------------------------------
  function computeBacktestMetrics(trades, initialCapital, finalCapital, equityCurve, options = {}) {
    const initCap = (typeof initialCapital === "number" && !isNaN(initialCapital) && initialCapital > 0) ? initialCapital : (initialCapital === 0 ? 0 : 10000);
    const finCap = (typeof finalCapital === "number" && !isNaN(finalCapital)) ? finalCapital : initCap;
    const tList = Array.isArray(trades) ? trades : [];

    const totalTrades = tList.length;
    const wins = tList.filter(t => t.netPnl > 0);
    const losses = tList.filter(t => t.netPnl < 0);
    const breakevens = tList.filter(t => t.netPnl === 0);

    const grossProfit = wins.reduce((s, t) => s + (t.grossPnl != null ? t.grossPnl : t.netPnl), 0);
    const grossLoss = Math.abs(losses.reduce((s, t) => s + (t.grossPnl != null ? t.grossPnl : t.netPnl), 0));
    const realizedPnl = tList.reduce((s, t) => s + (t.netPnl || 0), 0);
    const totalFees = tList.reduce((s, t) => s + (t.fees || 0), 0);
    const bankruptcyDeficit = tList.reduce((s, t) => s + (t.bankruptcyDeficit || 0), 0);

    // Account Net Profit and Return
    const netProfit = finCap - initCap;
    const netProfitPct = initCap > 0 ? (netProfit / initCap) * 100 : 0;

    const winRate = totalTrades > 0 ? (wins.length / totalTrades) * 100 : 0;
    const lossRate = totalTrades > 0 ? (losses.length / totalTrades) * 100 : 0;
    const profitFactor = grossLoss > 0 ? (grossProfit / grossLoss) : (grossProfit > 0 ? Infinity : 0);

    const avgWin = wins.length > 0 ? grossProfit / wins.length : 0;
    const avgLoss = losses.length > 0 ? grossLoss / losses.length : 0;
    const winLossRatio = avgLoss > 0 ? (avgWin / avgLoss) : (avgWin > 0 ? Infinity : null);
    const avgTrade = totalTrades > 0 ? realizedPnl / totalTrades : 0;
    const expectancy = totalTrades > 0 ? realizedPnl / totalTrades : 0;

    // Consecutive winning and losing streaks
    let curWinStreak = 0, curLossStreak = 0;
    let maxConsecWins = 0, maxConsecLosses = 0;
    let winStreaks = [], lossStreaks = [];
    tList.forEach(t => {
      if (t.netPnl > 0) {
        curWinStreak++;
        if (curLossStreak > 0) { lossStreaks.push(curLossStreak); curLossStreak = 0; }
        if (curWinStreak > maxConsecWins) maxConsecWins = curWinStreak;
      } else if (t.netPnl < 0) {
        curLossStreak++;
        if (curWinStreak > 0) { winStreaks.push(curWinStreak); curWinStreak = 0; }
        if (curLossStreak > maxConsecLosses) maxConsecLosses = curLossStreak;
      }
    });
    if (curWinStreak > 0) winStreaks.push(curWinStreak);
    if (curLossStreak > 0) lossStreaks.push(curLossStreak);
    const avgConsecWins = winStreaks.length ? winStreaks.reduce((a, b) => a + b, 0) / winStreaks.length : 0;
    const avgConsecLosses = lossStreaks.length ? lossStreaks.reduce((a, b) => a + b, 0) / lossStreaks.length : 0;

    // Drawdown Calculation:
    // Tracks maximum peak-to-trough equity drop
    let maxDrawdownUsd = 0;
    let maxDrawdownPct = 0;
    let peak = initCap;

    if (Array.isArray(equityCurve) && equityCurve.length > 0) {
      for (const pt of equityCurve) {
        if (pt && typeof pt.value === "number" && !isNaN(pt.value)) {
          if (pt.value > peak) peak = pt.value;
          const dd = peak - pt.value;
          if (dd > maxDrawdownUsd) maxDrawdownUsd = dd;
          const ddPct = peak > 0 ? (dd / peak) * 100 : 0;
          if (ddPct > maxDrawdownPct) maxDrawdownPct = ddPct;
        }
      }
    }
    // Also verify against closed-trades running equity to capture every trade close
    let runningEq = initCap;
    let trPeak = initCap;
    for (const t of tList) {
      runningEq = Math.max(0, runningEq + (t.netPnl || 0));
      if (runningEq > trPeak) trPeak = runningEq;
      const dd = trPeak - runningEq;
      if (dd > maxDrawdownUsd) maxDrawdownUsd = dd;
      const ddPct = trPeak > 0 ? (dd / trPeak) * 100 : 0;
      if (ddPct > maxDrawdownPct) maxDrawdownPct = ddPct;
    }

    const recoveryFactor = maxDrawdownUsd > 0 ? (netProfit / maxDrawdownUsd) : (netProfit > 0 ? Infinity : 0);

    // Sharpe & Sortino (annualized based on equityCurve returns or trade returns)
    let rets = [];
    let negRets = [];
    const eq = Array.isArray(equityCurve) && equityCurve.length > 1 ? equityCurve : null;
    if (eq) {
      for (let k = 1; k < eq.length; k++) {
        const prev = eq[k - 1].value;
        const curr = eq[k].value;
        if (prev > 0) {
          const r = (curr - prev) / prev;
          rets.push(r);
          if (r < 0) negRets.push(r);
        }
      }
    } else if (tList.length > 1) {
      let prevEq = initCap;
      for (const t of tList) {
        const nextEq = Math.max(0, prevEq + (t.netPnl || 0));
        if (prevEq > 0) {
          const r = (nextEq - prevEq) / prevEq;
          rets.push(r);
          if (r < 0) negRets.push(r);
        }
        prevEq = nextEq;
      }
    }

    const meanRet = rets.length ? rets.reduce((a, b) => a + b, 0) / rets.length : 0;
    const variance = rets.length > 1 ? rets.reduce((a, b) => a + Math.pow(b - meanRet, 2), 0) / (rets.length - 1) : 0;
    const stdDev = Math.sqrt(variance);
    const sharpe = stdDev > 0 ? (meanRet / stdDev) * Math.sqrt(365 * 24) : 0;
    const downsideVar = negRets.length > 1 ? negRets.reduce((a, b) => a + Math.pow(b, 2), 0) / negRets.length : 0;
    const downsideDev = Math.sqrt(downsideVar);
    const sortino = downsideDev > 0 ? (meanRet / downsideDev) * Math.sqrt(365 * 24) : (sharpe > 0 ? sharpe * 1.3 : 0);

    return {
      initialCapital: initCap,
      finalCapital: finCap,
      netProfit,
      netProfitPct,
      realizedPnl,
      grossProfit,
      grossLoss,
      totalTrades,
      wins: wins.length,
      winningTrades: wins.length,
      losses: losses.length,
      losingTrades: losses.length,
      breakevens: breakevens.length,
      winRate,
      lossRate,
      profitFactor,
      avgWin,
      avgLoss,
      winLossRatio,
      avgTrade,
      expectancy,
      maxConsecWins,
      maxConsecLosses,
      avgConsecWins,
      avgConsecLosses,
      maxDrawdownUsd,
      maxDrawdown: maxDrawdownUsd,
      maxDrawdownPct,
      recoveryFactor,
      sharpe,
      sortino,
      totalFees,
      bankruptcyDeficit,
      equityReconciled: Math.abs(finCap - (initCap + realizedPnl + bankruptcyDeficit)) < 1e-6
    };
  }

  // Pure AST Program Executor & Broker Emulator
  function executeASTProgram(ast, dataset, options = {}) {
    const { times, opens, highs, lows, closes, volumes } = dataset;
    const N = closes ? closes.length : 0;
    if (N === 0) {
      const initCap = options.initialCapital || 10000;
      return {
        success: true,
        trades: [],
        metrics: computeBacktestMetrics([], initCap, initCap, []),
        equityCurve: [],
        signals: [],
        plots: {}
      };
    }

    // Runtime Environment
    const env = {
      dataset,
      series: new Map(),
      vars: new Map(),
      functions: new Map(),
      inputs: Object.assign({}, options.inputs || {}),
      strategyConfig: {
        initialCapital: options.initialCapital || 10000,
        pyramiding: 1,
        default_qty_type: "strategy.percent_of_equity",
        default_qty_value: 10,
        commission_type: "strategy.commission.percent",
        commission_value: 0.04,
        slippage: 0
      },
      strategySeries: {
        "strategy.closedtrades": new Float64Array(N),
        "strategy.opentrades": new Float64Array(N),
        "strategy.position_size": new Float64Array(N),
        "strategy.position_avg_price": new Float64Array(N),
        "strategy.equity": new Float64Array(N),
        "strategy.netprofit": new Float64Array(N)
      },
      state: {
        capital: options.initialCapital || 10000,
        initialCapital: options.initialCapital || 10000,
        position: null,
        closedtrades: 0,
        opentrades: 0
      }
    };

    // Register User-Defined Functions
    for (const node of ast.body) {
      if (node && node.type === "FunctionDeclaration") {
        env.functions.set(node.name, node);
      }
    }

    // Pre-Scan and pre-compute indicator vectors
    preScanAndVectorize(ast, dataset, options, env);

    // Derived strategy options from script configuration and caller overrides
    const initialCapital = (typeof options.initialCapital === "number") ? options.initialCapital : (env.strategyConfig.initialCapital || 10000);
    const leverage = options.leverage || 10;
    const maxPyramiding = Math.max(1, env.strategyConfig.pyramiding || 1);

    const commType = env.strategyConfig.commission_type || "strategy.commission.percent";
    const commVal = (typeof env.strategyConfig.commission_value === "number") ? env.strategyConfig.commission_value : null;
    let feeRate = (typeof options.feeRate === "number") ? options.feeRate : 0.0004;
    if (commVal !== null && (commType.includes("percent") || commType === "percent")) {
      feeRate = commVal / 100.0;
    }

    const slippageTicks = (typeof env.strategyConfig.slippage === "number") ? env.strategyConfig.slippage : 0;
    const slippageBps = (typeof options.slippageBps === "number") ? options.slippageBps : (slippageTicks > 0 ? slippageTicks : 2);
    const slippageFactor = slippageBps / 10000;

    env.state.capital = initialCapital;
    env.state.initialCapital = initialCapital;

    // Pre-allocate runtime variable series for all variables declared in script
    const varDecls = new Map();
    for (const node of ast.body) {
      if (node && node.type === "Declaration") {
        if (node.init && node.init.type === "CallExpression" && node.init.callee && node.init.callee.name && node.init.callee.name.startsWith("input")) {
          continue;
        }
        if (!env.vars.has(node.name) && !env.series.has(node.name)) {
          env.vars.set(node.name, new Float64Array(N));
        }
        if (node.isVar) {
          varDecls.set(node.name, node);
        }
      }
    }

    // Extract plot statements
    const plots = {};
    for (const node of ast.body) {
      if (node && node.type === "ExpressionStatement" && node.expression && node.expression.type === "CallExpression") {
        const call = node.expression;
        if (call.callee && call.callee.name === "plot") {
          const exprNode = call.args[0];
          const titleArg = getArgValue(call.args, "title", 1);
          const colorArg = getArgValue(call.args, "color", 2);
          const title = (titleArg && titleArg.type === "Literal") ? titleArg.value : (exprNode && exprNode.name ? exprNode.name : `Plot_${Object.keys(plots).length + 1}`);
          const color = (colorArg && colorArg.type === "Literal") ? colorArg.value : "#2962ff";
          plots[title] = { exprNode, title, color, data: [] };
        }
      }
    }

    // Broker Emulator State
    let capital = initialCapital;
    let position = null; // { id, side: "LONG"|"SHORT", qty, entryPrice, entryTime, entryBar, fees, stop, limit, trail_points, trail_offset, trail_price, highWaterMark, lowWaterMark, lots }
    let pendingEntry = null; // Order placed for next bar Open
    const defaultBrackets = new Map(); // Store exit bracket settings per entry ID
    const trades = [];
    const signals = [];
    const equityCurve = [{ time: times[0], value: capital }];
    const eqStep = N > 2000 ? Math.ceil(N / 2000) : 1;

    // Helper to evaluate and execute statements inside an AST block
    function executeBlock(statements, barIndex) {
      for (const stmt of statements) {
        if (!stmt) continue;
        if (stmt.type === "FunctionDeclaration") continue;

        if (stmt.type === "Declaration") {
          if (stmt.init && stmt.init.type === "CallExpression" && stmt.init.callee && stmt.init.callee.name && stmt.init.callee.name.startsWith("input")) {
            continue;
          }
          if (!stmt.isVar || barIndex === 0) {
            const val = evaluateExpression(stmt.init, barIndex, env);
            if (env.vars.has(stmt.name)) {
              env.vars.get(stmt.name)[barIndex] = (val === null || val === undefined) ? NaN : val;
            }
          }
        } else if (stmt.type === "Reassignment") {
          const val = evaluateExpression(stmt.value, barIndex, env);
          if (env.vars.has(stmt.name)) {
            const arr = env.vars.get(stmt.name);
            const numVal = (val === null || val === undefined) ? NaN : val;
            if (stmt.operator === ":=") arr[barIndex] = numVal;
            else if (stmt.operator === "+=") arr[barIndex] += numVal;
            else if (stmt.operator === "-=") arr[barIndex] -= numVal;
            else if (stmt.operator === "*=") arr[barIndex] *= numVal;
            else if (stmt.operator === "/=") arr[barIndex] /= numVal;
          }
        } else if (stmt.type === "IfStatement") {
          const cond = evaluateExpression(stmt.condition, barIndex, env);
          if (cond) {
            if (stmt.consequent) executeBlock(stmt.consequent, barIndex);
          } else if (stmt.alternate) {
            executeBlock(stmt.alternate, barIndex);
          }
        } else if (stmt.type === "ExpressionStatement") {
          const expr = stmt.expression;
          if (expr && expr.type === "CallExpression") {
            const callee = expr.callee ? expr.callee.name : "";

            if (callee === "strategy.entry") {
              const idArg = getArgValue(expr.args, "id", 0);
              const id = (idArg && idArg.type === "Literal") ? idArg.value : (idArg && idArg.name ? idArg.name : "Buy");
              const dirArg = getArgValue(expr.args, "direction", 1);
              const dirVal = evaluateExpression(dirArg, barIndex, env);
              const side = (dirVal === "SHORT" || dirVal === -1) ? "SHORT" : "LONG";

              const whenArg = getArgValue(expr.args, "when");
              const whenVal = whenArg ? evaluateExpression(whenArg, barIndex, env) : true;

              if (whenVal) {
                // Read default bracket if configured
                const bracket = defaultBrackets.get(id) || {};
                const qtyArg = getArgValue(expr.args, "qty");
                const explicitQty = qtyArg ? evaluateExpression(qtyArg, barIndex, env) : null;
                const entryLimitArg = getArgValue(expr.args, "limit");
                const entryLimit = entryLimitArg ? evaluateExpression(entryLimitArg, barIndex, env) : null;
                const entryStopArg = getArgValue(expr.args, "stop");
                const entryStop = entryStopArg ? evaluateExpression(entryStopArg, barIndex, env) : null;

                pendingEntry = {
                  id,
                  side,
                  qty: (explicitQty !== null && !isNaN(explicitQty) && explicitQty > 0) ? explicitQty : null,
                  entryLimit: (entryLimit !== null && !isNaN(entryLimit)) ? entryLimit : null,
                  entryStop: (entryStop !== null && !isNaN(entryStop)) ? entryStop : null,
                  stop: bracket.stop !== undefined ? bracket.stop : null,
                  limit: bracket.limit !== undefined ? bracket.limit : null,
                  trail_points: bracket.trail_points || null,
                  trail_offset: bracket.trail_offset || null,
                  trail_price: bracket.trail_price || null
                };
                signals.push({
                  barIndex,
                  time: times[barIndex],
                  action: "entry",
                  id,
                  direction: side,
                  price: closes[barIndex]
                });
              }
            } else if (callee === "strategy.close") {
              const idArg = getArgValue(expr.args, "id", 0);
              const id = (idArg && idArg.type === "Literal") ? idArg.value : (idArg && idArg.name ? idArg.name : null);
              const whenArg = getArgValue(expr.args, "when");
              const whenVal = whenArg ? evaluateExpression(whenArg, barIndex, env) : true;

              if (whenVal && position && (!id || position.id === id)) {
                // Execute Strategy Close at bar Close
                const barClose = closes[barIndex];
                const slippedExit = position.side === "LONG"
                  ? barClose * (1 - slippageFactor)
                  : barClose * (1 + slippageFactor);
                const grossPnl = position.side === "LONG"
                  ? (slippedExit - position.entryPrice) * position.qty
                  : (position.entryPrice - slippedExit) * position.qty;
                const exitFee = slippedExit * position.qty * feeRate;
                const totalFees = position.fees + exitFee;
                const netPnl = grossPnl - totalFees;
                capital += netPnl;

                signals.push({
                  barIndex,
                  time: times[barIndex],
                  action: "close",
                  id: position.id,
                  price: barClose
                });

                trades.push({
                  id: trades.length + 1,
                  symbol: options.symbol || "BTCUSDT",
                  side: position.side,
                  qty: position.qty,
                  entryPrice: position.entryPrice,
                  entryTime: position.entryTime,
                  entryBar: position.entryBar,
                  exitPrice: slippedExit,
                  exitTime: times[barIndex],
                  exitBar: barIndex,
                  grossPnl,
                  fees: totalFees,
                  netPnl,
                  returnPct: (netPnl / (position.qty * position.entryPrice / leverage)) * 100,
                  reason: "Strategy Close"
                });
                position = null;
              }
            } else if (callee === "strategy.close_all") {
              const whenArg = getArgValue(expr.args, "when");
              const whenVal = whenArg ? evaluateExpression(whenArg, barIndex, env) : true;
              if (whenVal && position) {
                const barClose = closes[barIndex];
                const slippedExit = position.side === "LONG"
                  ? barClose * (1 - slippageFactor)
                  : barClose * (1 + slippageFactor);
                const grossPnl = position.side === "LONG"
                  ? (slippedExit - position.entryPrice) * position.qty
                  : (position.entryPrice - slippedExit) * position.qty;
                const exitFee = slippedExit * position.qty * feeRate;
                const totalFees = position.fees + exitFee;
                const netPnl = grossPnl - totalFees;
                capital += netPnl;

                signals.push({
                  barIndex,
                  time: times[barIndex],
                  action: "close",
                  id: position.id,
                  price: barClose
                });

                trades.push({
                  id: trades.length + 1,
                  symbol: options.symbol || "BTCUSDT",
                  side: position.side,
                  qty: position.qty,
                  entryPrice: position.entryPrice,
                  entryTime: position.entryTime,
                  entryBar: position.entryBar,
                  exitPrice: slippedExit,
                  exitTime: times[barIndex],
                  exitBar: barIndex,
                  grossPnl,
                  fees: totalFees,
                  netPnl,
                  returnPct: (netPnl / (position.qty * position.entryPrice / leverage)) * 100,
                  reason: "Strategy Close All"
                });
                position = null;
              }
            } else if (callee === "strategy.exit") {
              const idArg = getArgValue(expr.args, "id", 0);
              const fromEntryArg = getArgValue(expr.args, "from_entry", 1);
              const fromEntry = (fromEntryArg && fromEntryArg.type === "Literal") ? fromEntryArg.value : (fromEntryArg && fromEntryArg.name ? fromEntryArg.name : null);

              const whenArg = getArgValue(expr.args, "when");
              const whenVal = whenArg ? evaluateExpression(whenArg, barIndex, env) : true;

              if (whenVal) {
                // Dynamic stop & limit evaluation from series buffers or expressions (Resolves GAP-01)
                const stopArg = getArgValue(expr.args, "stop");
                const limitArg = getArgValue(expr.args, "limit");
                const profitArg = getArgValue(expr.args, "profit");
                const lossArg = getArgValue(expr.args, "loss");
                const trailPriceArg = getArgValue(expr.args, "trail_price");
                const trailOffsetArg = getArgValue(expr.args, "trail_offset");
                const trailPointsArg = getArgValue(expr.args, "trail_points");

                let stopVal = stopArg ? evaluateExpression(stopArg, barIndex, env) : null;
                let limitVal = limitArg ? evaluateExpression(limitArg, barIndex, env) : null;
                const trailPriceVal = trailPriceArg ? evaluateExpression(trailPriceArg, barIndex, env) : null;
                const trailOffsetVal = trailOffsetArg ? evaluateExpression(trailOffsetArg, barIndex, env) : null;
                const trailPointsVal = trailPointsArg ? evaluateExpression(trailPointsArg, barIndex, env) : null;

                // Profit / Loss tick offsets relative to position entry price
                if (position) {
                  if (profitArg) {
                    const pVal = evaluateExpression(profitArg, barIndex, env);
                    limitVal = position.side === "LONG" ? position.entryPrice + pVal : position.entryPrice - pVal;
                  }
                  if (lossArg) {
                    const lVal = evaluateExpression(lossArg, barIndex, env);
                    stopVal = position.side === "LONG" ? position.entryPrice - lVal : position.entryPrice + lVal;
                  }
                }

                const bracketObj = {
                  stop: (stopVal !== null && !isNaN(stopVal)) ? stopVal : null,
                  limit: (limitVal !== null && !isNaN(limitVal)) ? limitVal : null,
                  trail_price: trailPriceVal,
                  trail_offset: trailOffsetVal,
                  trail_points: trailPointsVal
                };

                // Store in default brackets map for future entries
                if (fromEntry) defaultBrackets.set(fromEntry, bracketObj);
                if (idArg && idArg.value) defaultBrackets.set(idArg.value, bracketObj);

                // Update active position bracket immediately
                if (position && (!fromEntry || position.id === fromEntry)) {
                  if (bracketObj.stop !== null) position.stop = bracketObj.stop;
                  if (bracketObj.limit !== null) position.limit = bracketObj.limit;
                  if (bracketObj.trail_price !== null) position.trail_price = bracketObj.trail_price;
                  if (bracketObj.trail_offset !== null) position.trail_offset = bracketObj.trail_offset;
                  if (bracketObj.trail_points !== null) position.trail_points = bracketObj.trail_points;
                }
                if (pendingEntry && (!fromEntry || pendingEntry.id === fromEntry)) {
                  if (bracketObj.stop !== null) pendingEntry.stop = bracketObj.stop;
                  if (bracketObj.limit !== null) pendingEntry.limit = bracketObj.limit;
                  if (bracketObj.trail_price !== null) pendingEntry.trail_price = bracketObj.trail_price;
                  if (bracketObj.trail_offset !== null) pendingEntry.trail_offset = bracketObj.trail_offset;
                  if (bracketObj.trail_points !== null) pendingEntry.trail_points = bracketObj.trail_points;
                }
              }
            }
          }
        }
      }
    }

    // Evaluate initial statements and variable declarations on Bar 0
    executeBlock(ast.body, 0);

    env.strategySeries["strategy.closedtrades"][0] = trades.length;
    env.strategySeries["strategy.opentrades"][0] = position ? 1 : 0;
    env.strategySeries["strategy.position_size"][0] = position ? (position.side === "LONG" ? position.qty : -position.qty) : 0;
    env.strategySeries["strategy.position_avg_price"][0] = position ? position.entryPrice : NaN;
    env.strategySeries["strategy.equity"][0] = capital;
    env.strategySeries["strategy.netprofit"][0] = 0;
    env.state.closedtrades = trades.length;
    env.state.opentrades = position ? 1 : 0;

    // Main Chronological Execution Loop
    for (let i = 1; i < N; i++) {
      // Carry forward persistent var variables
      for (const [vName] of varDecls) {
        if (env.vars.has(vName)) {
          env.vars.get(vName)[i] = env.vars.get(vName)[i - 1];
        }
      }

      const barOpen = opens[i];
      const barHigh = highs[i];
      const barLow = lows[i];
      const barClose = closes[i];
      const barTime = times[i];

      // Update env state for strategy position access
      env.state.capital = capital;
      env.state.position = position;

      // 1. Process pending entry orders at bar Open or limit/stop touch
      if (pendingEntry) {
        let fillsNow = true;
        let fillBasePrice = barOpen;

        if (pendingEntry.entryLimit !== null && pendingEntry.entryLimit !== undefined) {
          if (pendingEntry.side === "LONG") {
            if (barLow <= pendingEntry.entryLimit) {
              fillBasePrice = Math.min(barOpen, pendingEntry.entryLimit);
            } else {
              fillsNow = false;
            }
          } else {
            if (barHigh >= pendingEntry.entryLimit) {
              fillBasePrice = Math.max(barOpen, pendingEntry.entryLimit);
            } else {
              fillsNow = false;
            }
          }
        } else if (pendingEntry.entryStop !== null && pendingEntry.entryStop !== undefined) {
          if (pendingEntry.side === "LONG") {
            if (barHigh >= pendingEntry.entryStop) {
              fillBasePrice = Math.max(barOpen, pendingEntry.entryStop);
            } else {
              fillsNow = false;
            }
          } else {
            if (barLow <= pendingEntry.entryStop) {
              fillBasePrice = Math.min(barOpen, pendingEntry.entryStop);
            } else {
              fillsNow = false;
            }
          }
        }

        if (fillsNow) {
          // Position Reversal Check
          if (position && position.side !== pendingEntry.side) {
            const slippedExit = position.side === "LONG"
              ? fillBasePrice * (1 - slippageFactor)
              : fillBasePrice * (1 + slippageFactor);
            const grossPnl = position.side === "LONG"
              ? (slippedExit - position.entryPrice) * position.qty
              : (position.entryPrice - slippedExit) * position.qty;
            const exitFee = slippedExit * position.qty * feeRate;
            const totalFees = position.fees + exitFee;
            const netPnl = grossPnl - totalFees;
            capital += netPnl;

            trades.push({
              id: trades.length + 1,
              symbol: options.symbol || "BTCUSDT",
              side: position.side,
              qty: position.qty,
              entryPrice: position.entryPrice,
              entryTime: position.entryTime,
              entryBar: position.entryBar,
              exitPrice: slippedExit,
              exitTime: barTime,
              exitBar: i,
              grossPnl,
              fees: totalFees,
              netPnl,
              returnPct: (netPnl / (position.qty * position.entryPrice / leverage)) * 100,
              reason: "Reversal Close"
            });
            position = null;
          }

          // Open or Scale-in with pyramiding support (GAP-03)
          const currentLots = position ? (position.lots ? position.lots.length : 1) : 0;
          if (!position || (position.side === pendingEntry.side && currentLots < maxPyramiding)) {
            if (capital <= 10) {
              pendingEntry = null;
              continue;
            }
            const slippedEntry = pendingEntry.side === "LONG"
              ? fillBasePrice * (1 + slippageFactor)
              : fillBasePrice * (1 - slippageFactor);

            let qty = (pendingEntry.qty && pendingEntry.qty > 0) ? pendingEntry.qty : null;
            if (!qty) {
              const qType = env.strategyConfig.default_qty_type || "strategy.percent_of_equity";
              const qVal = (typeof env.strategyConfig.default_qty_value === "number") ? env.strategyConfig.default_qty_value : 10;
              if (qType.includes("percent_of_equity") || qType === "percent_of_equity") {
                const curEquity = capital + (position ? ((position.side === "LONG" ? fillBasePrice - position.entryPrice : position.entryPrice - fillBasePrice) * position.qty) : 0);
                const alloc = Math.max(0, curEquity * (qVal / 100.0));
                qty = (alloc * leverage) / slippedEntry;
              } else if (qType.includes("fixed") || qType === "fixed") {
                qty = qVal;
              } else if (qType.includes("cash") || qType === "cash") {
                qty = (qVal * leverage) / slippedEntry;
              } else {
                qty = ((capital * 0.1) * leverage) / slippedEntry;
              }
            }

            const requiredMargin = (qty * slippedEntry) / leverage;
            const entryFee = qty * slippedEntry * feeRate;

            if (requiredMargin + entryFee > capital) {
              // Insufficient margin / capital for requested quantity: reject order without scaling
              pendingEntry = null;
              continue;
            }

            const newLot = {
              id: pendingEntry.id,
              qty,
              entryPrice: slippedEntry,
              entryTime: barTime,
              entryBar: i,
              fees: entryFee
            };

            const bracket = defaultBrackets.get(pendingEntry.id) || {};
            if (!position) {
              position = {
                id: pendingEntry.id,
                side: pendingEntry.side,
                qty,
                entryPrice: slippedEntry,
                entryTime: barTime,
                entryBar: i,
                fees: entryFee,
                stop: pendingEntry.stop !== null ? pendingEntry.stop : (bracket.stop !== undefined ? bracket.stop : null),
                limit: pendingEntry.limit !== null ? pendingEntry.limit : (bracket.limit !== undefined ? bracket.limit : null),
                trail_points: pendingEntry.trail_points || bracket.trail_points || null,
                trail_offset: pendingEntry.trail_offset || bracket.trail_offset || null,
                trail_price: pendingEntry.trail_price || bracket.trail_price || null,
                highWaterMark: barHigh,
                lowWaterMark: barLow,
                lots: [newLot]
              };
            } else {
              position.lots.push(newLot);
              const totalNotional = position.lots.reduce((s, l) => s + l.qty * l.entryPrice, 0);
              position.qty = position.lots.reduce((s, l) => s + l.qty, 0);
              position.entryPrice = totalNotional / position.qty;
              position.fees += entryFee;
              if (pendingEntry.stop !== null) position.stop = pendingEntry.stop;
              else if (bracket.stop !== undefined && bracket.stop !== null) position.stop = bracket.stop;
              if (pendingEntry.limit !== null) position.limit = pendingEntry.limit;
              else if (bracket.limit !== undefined && bracket.limit !== null) position.limit = bracket.limit;
            }
          }
          pendingEntry = null;
        }
      }

      // 2. Intrabar Stop / Limit Bracket Execution for open position
      if (position && (position.stop !== null || position.limit !== null || position.trail_price !== null)) {
        const priorStop = position.stop;
        const priorLimit = position.limit;

        // Trailing Stop Ratchet Logic (Resolves GAP-02)
        if (position.side === "LONG") {
          position.highWaterMark = Math.max(position.highWaterMark || position.entryPrice, barHigh);
          if (position.trail_price !== null && position.highWaterMark >= position.trail_price && position.trail_offset !== null) {
            const dynTrailStop = position.highWaterMark - position.trail_offset;
            if (position.stop === null || dynTrailStop > position.stop) position.stop = dynTrailStop;
          }
        } else if (position.side === "SHORT") {
          position.lowWaterMark = Math.min(position.lowWaterMark || position.entryPrice, barLow);
          if (position.trail_price !== null && position.lowWaterMark <= position.trail_price && position.trail_offset !== null) {
            const dynTrailStop = position.lowWaterMark + position.trail_offset;
            if (position.stop === null || dynTrailStop < position.stop) position.stop = dynTrailStop;
          }
        }

        let exitPrice = null;
        let exitReason = "";

        if (position.side === "LONG") {
          const hitStop = position.stop !== null && barLow <= position.stop;
          const hitLimit = position.limit !== null && barHigh >= position.limit;
          const effectiveStop = (priorStop !== null && barOpen <= priorStop) ? barOpen : position.stop;
          const effectiveLimit = (priorLimit !== null && barOpen >= priorLimit) ? barOpen : position.limit;

          if (hitStop && hitLimit) {
            // Same-bar collision: evaluate open proximity
            if (Math.abs(barOpen - position.stop) < Math.abs(barOpen - position.limit)) {
              exitPrice = effectiveStop;
              exitReason = "Stop Loss";
            } else {
              exitPrice = effectiveLimit;
              exitReason = "Take Profit";
            }
          } else if (hitStop) {
            exitPrice = effectiveStop;
            exitReason = "Stop Loss";
          } else if (hitLimit) {
            exitPrice = effectiveLimit;
            exitReason = "Take Profit";
          }
        } else if (position.side === "SHORT") {
          const hitStop = position.stop !== null && barHigh >= position.stop;
          const hitLimit = position.limit !== null && barLow <= position.limit;
          const effectiveStop = (priorStop !== null && barOpen >= priorStop) ? barOpen : position.stop;
          const effectiveLimit = (priorLimit !== null && barOpen <= priorLimit) ? barOpen : position.limit;

          if (hitStop && hitLimit) {
            if (Math.abs(barOpen - position.stop) < Math.abs(barOpen - position.limit)) {
              exitPrice = effectiveStop;
              exitReason = "Stop Loss";
            } else {
              exitPrice = effectiveLimit;
              exitReason = "Take Profit";
            }
          } else if (hitStop) {
            exitPrice = effectiveStop;
            exitReason = "Stop Loss";
          } else if (hitLimit) {
            exitPrice = effectiveLimit;
            exitReason = "Take Profit";
          }
        }

        if (exitPrice !== null) {
          const slippedExit = position.side === "LONG"
            ? exitPrice * (1 - slippageFactor)
            : exitPrice * (1 + slippageFactor);
          const grossPnl = position.side === "LONG"
            ? (slippedExit - position.entryPrice) * position.qty
            : (position.entryPrice - slippedExit) * position.qty;
          const exitFee = slippedExit * position.qty * feeRate;
          const totalFees = position.fees + exitFee;
          const netPnl = grossPnl - totalFees;
          capital += netPnl;

          trades.push({
            id: trades.length + 1,
            symbol: options.symbol || "BTCUSDT",
            side: position.side,
            qty: position.qty,
            entryPrice: position.entryPrice,
            entryTime: position.entryTime,
            entryBar: position.entryBar,
            exitPrice: slippedExit,
            exitTime: barTime,
            exitBar: i,
            grossPnl,
            fees: totalFees,
            netPnl,
            returnPct: (netPnl / (position.qty * position.entryPrice / leverage)) * 100,
            reason: exitReason
          });
          position = null;
        }
      }

      // 2b. Margin Call & Futures Liquidation Check (100% margin wipeout)
      if (position) {
        // Exact bankruptcy price where netPnl = grossPnl - totalFees = -capital
        let bankruptcyPrice;
        if (position.side === "LONG") {
          const num = (position.entryPrice * position.qty) + position.fees - capital;
          const den = position.qty * (1 - feeRate);
          bankruptcyPrice = den > 0 ? num / den : position.entryPrice;
        } else {
          const num = (position.entryPrice * position.qty) - position.fees + capital;
          const den = position.qty * (1 + feeRate);
          bankruptcyPrice = den > 0 ? num / den : position.entryPrice;
        }

        const isLiquidated = position.side === "LONG"
          ? barLow <= bankruptcyPrice
          : barHigh >= bankruptcyPrice;

        if (isLiquidated) {
          const liqExit = (position.side === "LONG" && barOpen < bankruptcyPrice)
            ? barOpen
            : ((position.side === "SHORT" && barOpen > bankruptcyPrice) ? barOpen : bankruptcyPrice);
          const grossPnl = position.side === "LONG"
            ? (liqExit - position.entryPrice) * position.qty
            : (position.entryPrice - liqExit) * position.qty;
          const exitFee = liqExit * position.qty * feeRate;
          const totalFees = position.fees + exitFee;
          const netPnl = grossPnl - totalFees;
          const deficit = Math.max(0, -(capital + netPnl));
          capital = Math.max(0, capital + netPnl);
          if (capital < 1e-6) capital = 0;

          trades.push({
            id: trades.length + 1,
            symbol: options.symbol || "BTCUSDT",
            side: position.side,
            qty: position.qty,
            entryPrice: position.entryPrice,
            entryTime: position.entryTime,
            entryBar: position.entryBar,
            exitPrice: liqExit,
            exitTime: barTime,
            exitBar: i,
            grossPnl,
            fees: totalFees,
            netPnl,
            bankruptcyDeficit: deficit,
            returnPct: -100,
            reason: "Liquidation"
          });
          signals.push({
            barIndex: i,
            time: barTime,
            action: "close",
            id: position.id,
            price: liqExit
          });
          position = null;
        }
      }

      // Update env state before evaluating AST statements
      env.state.capital = capital;
      env.state.position = position;

      // 3. Evaluate AST Program Statements for current bar
      executeBlock(ast.body, i);

      // Record per-bar strategy state for historical series indexing [n]
      const curEquity = capital + (position ? ((position.side === "LONG" ? barClose - position.entryPrice : position.entryPrice - barClose) * position.qty) : 0);
      env.strategySeries["strategy.closedtrades"][i] = trades.length;
      env.strategySeries["strategy.opentrades"][i] = position ? 1 : 0;
      env.strategySeries["strategy.position_size"][i] = position ? (position.side === "LONG" ? position.qty : -position.qty) : 0;
      env.strategySeries["strategy.position_avg_price"][i] = position ? position.entryPrice : NaN;
      env.strategySeries["strategy.equity"][i] = curEquity;
      env.strategySeries["strategy.netprofit"][i] = capital - initialCapital;
      env.state.closedtrades = trades.length;
      env.state.opentrades = position ? 1 : 0;

      // Track equity curve sampled
      if (i % eqStep === 0 || i === N - 1) {
        equityCurve.push({ time: barTime, value: capital });
      }
    }

    // Populate plot series data with downsampling (max 5,000 points)
    const MAX_CHART_POINTS = 5000;
    const plotStep = N > MAX_CHART_POINTS ? Math.ceil(N / MAX_CHART_POINTS) : 1;

    for (const [title, pObj] of Object.entries(plots)) {
      const outLen = Math.ceil(N / plotStep);
      pObj.data = new Array(outLen);
      let outIdx = 0;
      for (let i = 0; i < N; i += plotStep) {
        const val = evaluateExpression(pObj.exprNode, i, env);
        pObj.data[outIdx++] = {
          time: times[i],
          value: (val === null || isNaN(val)) ? null : val
        };
      }
      if ((N - 1) % plotStep !== 0) {
        const val = evaluateExpression(pObj.exprNode, N - 1, env);
        pObj.data.push({
          time: times[N - 1],
          value: (val === null || isNaN(val)) ? null : val
        });
      }
    }

    // Close remaining position at last bar close
    if (position) {
      const slippedExit = position.side === "LONG"
        ? closes[N - 1] * (1 - slippageFactor)
        : closes[N - 1] * (1 + slippageFactor);
      const grossPnl = position.side === "LONG"
        ? (slippedExit - position.entryPrice) * position.qty
        : (position.entryPrice - slippedExit) * position.qty;
      const exitFee = slippedExit * position.qty * feeRate;
      const totalFees = position.fees + exitFee;
      const netPnl = grossPnl - totalFees;
      capital += netPnl;

      trades.push({
        id: trades.length + 1,
        symbol: options.symbol || "BTCUSDT",
        side: position.side,
        qty: position.qty,
        entryPrice: position.entryPrice,
        entryTime: position.entryTime,
        entryBar: position.entryBar,
        exitPrice: slippedExit,
        exitTime: times[N - 1],
        exitBar: N - 1,
        grossPnl,
        fees: totalFees,
        netPnl,
        returnPct: (netPnl / (position.qty * position.entryPrice / leverage)) * 100,
        reason: "Test Period Ended"
      });
      position = null;
    }

    // Performance Metrics Compilation
    const metrics = computeBacktestMetrics(trades, initialCapital, capital, equityCurve, options);

    return {
      success: true,
      errors: [],
      signals,
      trades,
      equityCurve,
      plots,
      barCount: N,
      metrics,
      vars: Object.fromEntries(env.vars)
    };
  }

  // Public Synchronous Execution API
  function executePineScript(scriptSource, dataset, options = {}) {
    if (Array.isArray(dataset)) dataset = barsToDataset(dataset);
    const val = validateScript(scriptSource);
    if (!val.isValid) {
      return {
        success: false,
        errors: val.errors,
        trades: [],
        metrics: null,
        plots: {}
      };
    }
    return executeASTProgram(val.ast, dataset, options);
  }

  // Asynchronous Execution with Cooperative Cancellation for Large Datasets
  async function executePineScriptAsync(scriptSource, dataset, options = {}, isCancelled = null, onProgress = null) {
    if (Array.isArray(dataset)) dataset = barsToDataset(dataset);
    const val = validateScript(scriptSource);
    if (!val.isValid) {
      return { success: false, errors: val.errors, trades: [], metrics: null, plots: {} };
    }

    if (isCancelled && isCancelled()) {
      return { success: false, cancelled: true };
    }

    // Report starting progress
    if (onProgress) onProgress(25);
    await new Promise(r => setTimeout(r, 0));

    if (isCancelled && isCancelled()) {
      return { success: false, cancelled: true };
    }

    // Execute AST Program
    const res = executeASTProgram(val.ast, dataset, options);
    if (onProgress) onProgress(100);
    return res;
  }

  // --------------------------------------------------------------------------
  // 6. Dedicated Web Worker Message Protocol Handler
  // --------------------------------------------------------------------------
  if (typeof self !== "undefined" && typeof self.postMessage === "function") {
    let currentJobId = 0;
    const cancelledJobs = new Set();

    self.onmessage = async function(e) {
      const msg = e.data || {};
      const { cmd, jobId, script, dataset, options } = msg;

      if (cmd === "CANCEL") {
        if (jobId) {
          cancelledJobs.add(jobId);
          if (jobId >= currentJobId) currentJobId = jobId + 1;
        }
        self.postMessage({ type: "CANCELLED", jobId });
        return;
      }

      if (cmd === "VALIDATE") {
        const val = validateScript(script || "");
        self.postMessage({ type: "VALIDATE_RESULT", jobId, result: val });
        return;
      }

      if (cmd === "PARSE") {
        const p = parsePine(script || "");
        self.postMessage({ type: "PARSE_RESULT", jobId, result: p });
        return;
      }

      if (cmd === "EXECUTE" || cmd === "BACKTEST") {
        currentJobId = jobId || (currentJobId + 1);
        const thisJob = currentJobId;

        // Handshake: Notify main thread that computation has officially started
        self.postMessage({ type: "STARTED", jobId: thisJob });
        self.postMessage({ type: "PROGRESS", jobId: thisJob, percent: 5, elapsedMs: 0 });

        const tStart = performance.now();
        try {
          let res;
          const N = dataset && dataset.closes ? dataset.closes.length : 0;
          if (N > 25000) {
            res = await executePineScriptAsync(script, dataset, options, () => cancelledJobs.has(thisJob), (pct) => {
              self.postMessage({ type: "PROGRESS", jobId: thisJob, percent: pct, elapsedMs: Math.round(performance.now() - tStart) });
            });
          } else {
            res = executePineScript(script, dataset, options);
          }

          // Ignore stale or cancelled jobs
          if (thisJob < currentJobId || cancelledJobs.has(thisJob) || (res && res.cancelled)) {
            cancelledJobs.delete(thisJob);
            return;
          }

          const tElapsed = performance.now() - tStart;
          self.postMessage({
            type: "COMPLETE",
            jobId: thisJob,
            result: res,
            elapsedMs: Math.round(tElapsed * 100) / 100
          });
        } catch (err) {
          if (thisJob < currentJobId || cancelledJobs.has(thisJob)) {
            cancelledJobs.delete(thisJob);
            return;
          }
          self.postMessage({
            type: "ERROR",
            jobId: thisJob,
            error: { message: err.message, stack: err.stack }
          });
        }
      }
    };
  }

  // --------------------------------------------------------------------------
  // Adapters & Exports for Main Thread & External Callers
  // --------------------------------------------------------------------------
  function barsToDataset(bars) {
    if (!bars || !bars.length) {
      return { times: new Float64Array(0), opens: new Float64Array(0), highs: new Float64Array(0), lows: new Float64Array(0), closes: new Float64Array(0), volumes: new Float64Array(0) };
    }
    if (bars.times && bars.closes) return bars;
    const N = bars.length;
    const times = new Float64Array(N);
    const opens = new Float64Array(N);
    const highs = new Float64Array(N);
    const lows = new Float64Array(N);
    const closes = new Float64Array(N);
    const volumes = new Float64Array(N);
    for (let i = 0; i < N; i++) {
      const b = bars[i];
      times[i] = b.time || b.openTime || 0;
      opens[i] = b.open || 0;
      highs[i] = b.high || 0;
      lows[i] = b.low || 0;
      closes[i] = b.close || 0;
      volumes[i] = b.volume || 0;
    }
    return { times, opens, highs, lows, closes, volumes };
  }

  // --------------------------------------------------------------------------
  // Multi-Timeframe Data Architecture & Bar Resampling (Clean Foundation)
  // --------------------------------------------------------------------------
  const MXDataManager = {
    parseTfToSeconds: function(tf) {
      if (tf == null || tf === "" || tf === "current") return null;
      const s = String(tf).trim().toUpperCase();
      if (!s) return null;

      if (/^\d+$/.test(s)) {
        return parseInt(s, 10) * 60;
      }
      const secMatch = s.match(/^(\d+)S$/);
      if (secMatch) {
        return parseInt(secMatch[1], 10);
      }
      const minMatch = s.match(/^(\d+)M$/);
      if (minMatch) {
        return parseInt(minMatch[1], 10) * 60;
      }
      const hrMatch = s.match(/^(\d+)H$/);
      if (hrMatch) {
        return parseInt(hrMatch[1], 10) * 3600;
      }
      if (s === "D") return 86400;
      const dayMatch = s.match(/^(\d+)D$/);
      if (dayMatch) {
        return parseInt(dayMatch[1], 10) * 86400;
      }
      if (s === "W") return 7 * 86400;
      const weekMatch = s.match(/^(\d+)W$/);
      if (weekMatch) {
        return parseInt(weekMatch[1], 10) * 7 * 86400;
      }
      if (s === "1MONTH" || s === "MONTH") return 30 * 86400;

      return null;
    },

    resampleDataset: function(barsOrDataset, targetTf) {
      const targetSec = typeof targetTf === "number" ? targetTf : this.parseTfToSeconds(targetTf);
      if (!targetSec || targetSec <= 0) {
        return Array.isArray(barsOrDataset) ? { bars: barsOrDataset, dataset: barsToDataset(barsOrDataset) } : { bars: [], dataset: barsOrDataset };
      }

      let bars = [];
      if (Array.isArray(barsOrDataset)) {
        bars = barsOrDataset;
      } else if (barsOrDataset && barsOrDataset.closes) {
        const N = barsOrDataset.closes.length;
        for (let i = 0; i < N; i++) {
          bars.push({
            time: barsOrDataset.times ? barsOrDataset.times[i] : i,
            open: barsOrDataset.opens ? barsOrDataset.opens[i] : 0,
            high: barsOrDataset.highs ? barsOrDataset.highs[i] : 0,
            low: barsOrDataset.lows ? barsOrDataset.lows[i] : 0,
            close: barsOrDataset.closes ? barsOrDataset.closes[i] : 0,
            volume: barsOrDataset.volumes ? barsOrDataset.volumes[i] : 0
          });
        }
      }

      if (!bars || bars.length === 0) {
        return {
          bars: [],
          dataset: {
            times: new Float64Array(0),
            opens: new Float64Array(0),
            highs: new Float64Array(0),
            lows: new Float64Array(0),
            closes: new Float64Array(0),
            volumes: new Float64Array(0)
          }
        };
      }

      const firstTime = bars[0].time || bars[0].openTime || 0;
      const isMs = firstTime > 2000000000;
      const stepUnit = isMs ? targetSec * 1000 : targetSec;

      const resampledBars = [];
      let currentBucket = null;

      for (let i = 0; i < bars.length; i++) {
        const b = bars[i];
        const t = b.time || b.openTime || 0;
        const bucketTime = Math.floor(t / stepUnit) * stepUnit;

        if (!currentBucket || currentBucket.time !== bucketTime) {
          if (currentBucket) {
            resampledBars.push(currentBucket);
          }
          currentBucket = {
            time: bucketTime,
            open: b.open,
            high: b.high,
            low: b.low,
            close: b.close,
            volume: b.volume || 0
          };
        } else {
          currentBucket.high = Math.max(currentBucket.high, b.high);
          currentBucket.low = Math.min(currentBucket.low, b.low);
          currentBucket.close = b.close;
          currentBucket.volume += (b.volume || 0);
        }
      }

      if (currentBucket) {
        resampledBars.push(currentBucket);
      }

      return {
        bars: resampledBars,
        dataset: barsToDataset(resampledBars)
      };
    },

    alignHTFSeries: function(baseTimes, htfTimes, htfValues, options = {}) {
      const lookahead = options.lookahead === true;
      const N = baseTimes ? baseTimes.length : 0;
      const aligned = new Float64Array(N);
      aligned.fill(NaN);

      if (!baseTimes || !htfTimes || !htfValues || htfTimes.length === 0) {
        return aligned;
      }

      let htfIdx = 0;
      const htfLen = htfTimes.length;
      const defaultDuration = htfLen > 1 ? (htfTimes[1] - htfTimes[0]) : 0;
      const htfDuration = options.htfDuration || defaultDuration;

      for (let i = 0; i < N; i++) {
        const bt = baseTimes[i];

        while (htfIdx + 1 < htfLen && htfTimes[htfIdx + 1] <= bt) {
          htfIdx++;
        }

        if (lookahead) {
          if (bt >= htfTimes[htfIdx]) {
            aligned[i] = htfValues[htfIdx];
          }
        } else {
          // Lookahead off: only closed HTF candles are visible to avoid look-ahead bias
          if (htfIdx === htfLen - 1 && htfDuration > 0 && bt >= (htfTimes[htfIdx] + htfDuration)) {
            aligned[i] = htfValues[htfIdx];
          } else if (htfIdx > 0 && bt >= htfTimes[htfIdx]) {
            aligned[i] = htfValues[htfIdx - 1];
          }
        }
      }

      return aligned;
    }
  };

  const MXPineEngineAdapter = {
    validateScript,
    parsePine,
    tokenize,
    barsToDataset,
    dataManager: MXDataManager,
    parseAndValidate: (code) => validateScript(code),
    extractInputs: (code) => {
      const res = validateScript(code);
      return res.inputs || [];
    },
    run: (code, bars, inputs = {}, opts = {}) => {
      const dataset = barsToDataset(bars);
      const mergedOpts = Object.assign({}, opts, { inputs: inputs || {} });
      const res = executePineScript(code, dataset, mergedOpts);
      return {
        success: res.success,
        errors: res.errors || [],
        inputs: inputs || {},
        signals: res.signals || [],
        trades: res.trades || [],
        metrics: res.metrics || null,
        plots: res.plots || {},
        equityCurve: res.equityCurve || [],
        barCount: bars ? bars.length : 0,
        meta: {}
      };
    },
    runAsync: (code, bars, inputs = {}, opts = {}, onProgress = null) => {
      const dataset = barsToDataset(bars);
      const mergedOpts = Object.assign({}, opts, { inputs: inputs || {} });
      return executePineScriptAsync(code, dataset, mergedOpts, () => false, onProgress);
    },
    getCapabilities: () => getCapabilities()
  };

  const MXBacktestEngineAdapter = {
    run: (strategyCode, bars, opts = {}) => {
      const dataset = barsToDataset(bars);
      const res = executePineScript(strategyCode, dataset, opts);
      if (!res || !res.success) {
        return {
          success: false,
          errors: (res && res.errors) || [{ line: 1, message: "Engine execution failed" }],
          trades: [],
          metrics: null,
          equityCurve: []
        };
      }
      return {
        success: true,
        opts: opts,
        trades: res.trades || [],
        metrics: res.metrics || null,
        equityCurve: res.equityCurve || [],
        signals: res.signals || [],
        plots: res.plots || {},
        vars: res.vars || {}
      };
    },
    simulate: (strat, bars, opts = {}, inputs = {}) => {
      const code = typeof strat === "string" ? strat : (strat && (strat.code || strat.script || strat.pineScript) ? (strat.code || strat.script || strat.pineScript) : "");
      const mergedInputs = Object.assign({}, (strat && strat.inputs) || {}, inputs || {});
      const mergedOpts = Object.assign({}, opts || {}, {
        inputs: mergedInputs,
        symbol: (opts && opts.symbol) || (strat && strat.symbol) || "BTCUSDT",
        initialCapital: (opts && opts.initialCapital) || (strat && strat.initialCapital) || 10000,
        leverage: (opts && opts.leverage) || (strat && strat.leverage) || 10,
        slPct: (strat && strat.slPct != null) ? strat.slPct : ((opts && opts.slPct != null) ? opts.slPct : (opts && opts.defaultSlPct)),
        tpPct: (strat && strat.tpPct != null) ? strat.tpPct : ((opts && opts.tpPct != null) ? opts.tpPct : (opts && opts.defaultTpPct))
      });
      return MXBacktestEngineAdapter.run(code, bars, mergedOpts);
    },
    calculateMetrics: computeBacktestMetrics,
    getCapabilities: () => getCapabilities()
  };

  function getCapabilities() {
    return {
      version: "5.0-compatible",
      engine: "Pine v5/v6 Clean-Room AST Engine",
      supportedCalls: Array.from(new Set([
        ...Object.keys(FUNCTION_SIGNATURES),
        "indicator", "strategy"
      ])),
      indicators: [
        "ta.ema", "ta.sma", "ta.wma", "ta.vwma", "ta.rsi", "ta.atr",
        "ta.macd", "ta.bb", "ta.dmi", "ta.highest", "ta.lowest",
        "ta.highestbars", "ta.lowestbars", "ta.valuewhen", "ta.crossover", "ta.crossunder",
        "ta.stdev", "ta.change", "ta.cum", "ta.barssince"
      ],
      math: [
        "math.abs", "math.max", "math.min", "math.round",
        "math.floor", "math.ceil", "math.sqrt", "math.pow",
        "math.sign", "math.log", "math.exp"
      ],
      strategy: [
        "strategy", "strategy.entry", "strategy.exit", "strategy.close", "strategy.close_all",
        "strategy.cancel", "strategy.cancel_all"
      ],
      stateVariables: [
        "strategy.position_size", "strategy.position_avg_price", "strategy.closedtrades",
        "strategy.opentrades", "strategy.netprofit", "strategy.equity", "strategy.openprofit",
        "strategy.initial_capital"
      ],
      constants: [
        "strategy.long", "strategy.short", "strategy.percent_of_equity", "strategy.fixed", "strategy.cash",
        "strategy.commission.percent", "strategy.commission.cash_per_contract", "strategy.commission.cash_per_order"
      ],
      types: Array.from(PINE_TYPES),
      features: {
        userDefinedFunctions: true,
        tupleDestructuring: true,
        varPersistence: true,
        trailingStops: true,
        pyramiding: true,
        gapFills: true,
        dynamicStops: true,
        historyIndexing: true,
        deficitAccounting: true,
        feeInclusiveLiquidation: true
      }
    };
  }

  const engineExports = {
    validateScript,
    parsePine,
    executePineScript,
    executePineScriptAsync,
    tokenize,
    barsToDataset,
    MXDataManager,
    calculateMetrics: computeBacktestMetrics,
    getCapabilities,
    PineEngine: {
      validateScript,
      parsePine,
      executePineScript,
      executePineScriptAsync,
      tokenize,
      barsToDataset,
      dataManager: MXDataManager,
      calculateMetrics: computeBacktestMetrics,
      getCapabilities
    },
    MXPine: MXPineEngineAdapter,
    MXBacktestEngine: MXBacktestEngineAdapter,
    MXBacktest: MXBacktestEngineAdapter
  };

  // Export for main thread direct / fallback usage
  if (typeof module !== "undefined" && module.exports) {
    module.exports = engineExports;
  }
  if (typeof window !== "undefined") {
    window.PineEngine = engineExports.PineEngine;
    window.PineEngine.barsToDataset = barsToDataset;
    window.PineEngine.dataManager = MXDataManager;
    window.PineEngine.calculateMetrics = computeBacktestMetrics;
    window.PineEngine.MXBacktestEngine = engineExports.MXBacktestEngine;
    window.MXPine = engineExports.MXPine;
    window.MXDataManager = MXDataManager;

    const btTarget = {};
    const btProxy = new Proxy(btTarget, {
      get: (target, prop) => {
        if (prop === "run" || prop === "simulate") return engineExports.MXBacktestEngine[prop];
        return prop in engineExports.MXBacktestEngine ? engineExports.MXBacktestEngine[prop] : target[prop];
      },
      set: (target, prop, val) => {
        if (prop === "run" || prop === "simulate") {
          // Safeguard AST run and simulate from being clobbered by legacy regex engine in index.html:6765
          return true;
        }
        target[prop] = val;
        return true;
      }
    });

    try {
      Object.defineProperty(window, "MXBacktestEngine", {
        get: () => btProxy,
        set: () => {},
        configurable: true
      });
      Object.defineProperty(window, "MXBacktest", {
        get: () => btProxy,
        set: () => {},
        configurable: true
      });
    } catch (e) {
      window.MXBacktestEngine = engineExports.MXBacktestEngine;
      window.MXBacktest = engineExports.MXBacktest;
    }
  }
})();
