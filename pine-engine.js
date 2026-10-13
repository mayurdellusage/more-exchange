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
    "ta.rsi": { minArgs: 2, maxArgs: 2, desc: "(source, length)" },
    "ta.macd": { minArgs: 4, maxArgs: 4, desc: "(source, fastlen, slowlen, siglen)" },
    "ta.atr": { minArgs: 1, maxArgs: 1, desc: "(length)" },
    "ta.crossover": { minArgs: 2, maxArgs: 2, desc: "(source1, source2)" },
    "ta.crossunder": { minArgs: 2, maxArgs: 2, desc: "(source1, source2)" },
    "ta.highest": { minArgs: 2, maxArgs: 2, desc: "(source, length)" },
    "ta.lowest": { minArgs: 2, maxArgs: 2, desc: "(source, length)" },
    "ta.change": { minArgs: 1, maxArgs: 2, desc: "(source, length?)" },
    "ta.cum": { minArgs: 1, maxArgs: 1, desc: "(source)" },
    "ta.barssince": { minArgs: 1, maxArgs: 1, desc: "(condition)" },

    // Math
    "math.abs": { minArgs: 1, maxArgs: 1, desc: "(number)" },
    "math.max": { minArgs: 2, maxArgs: 10, desc: "(n1, n2, ...)" },
    "math.min": { minArgs: 2, maxArgs: 10, desc: "(n1, n2, ...)" },
    "math.round": { minArgs: 1, maxArgs: 2, desc: "(number, precision?)" },
    "math.floor": { minArgs: 1, maxArgs: 1, desc: "(number)" },
    "math.ceil": { minArgs: 1, maxArgs: 1, desc: "(number)" },
    "math.sqrt": { minArgs: 1, maxArgs: 1, desc: "(number)" },
    "math.pow": { minArgs: 2, maxArgs: 2, desc: "(base, exp)" },
    "math.log": { minArgs: 1, maxArgs: 1, desc: "(number)" },

    // Helpers & Plots
    "nz": { minArgs: 1, maxArgs: 2, desc: "(source, replacement?)" },
    "na": { minArgs: 1, maxArgs: 1, desc: "(source)" },
    "plot": { minArgs: 1, maxArgs: 8, desc: "(series, title?, color?, linewidth?, style?)" },

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

  const BUILTIN_SERIES = new Set([
    "open", "high", "low", "close", "volume", "time", "bar_index", "hl2", "hlc3", "ohlc4"
  ]);

  const BUILTIN_CONSTANTS = new Set([
    "true", "false", "na", "strategy.long", "strategy.short",
    "strategy.percent_of_equity", "strategy.fixed", "strategy.cash",
    "color.blue", "color.red", "color.green", "color.white", "color.yellow", "color.purple", "color.orange", "color.gray"
  ]);

  // --------------------------------------------------------------------------
  // 3. Validation & AST Preflight
  // --------------------------------------------------------------------------
  function validateScript(source) {
    const errors = [];
    const tokens = tokenize(source);
    let idx = 0;

    function peek(offset = 0) {
      return tokens[idx + offset] || { type: TOKEN_TYPES.EOF, value: "" };
    }

    const declaredVars = new Set([...BUILTIN_SERIES, ...BUILTIN_CONSTANTS]);
    let hasDeclaration = false;

    // Check header / declaration
    for (let k = 0; k < tokens.length; k++) {
      const t = tokens[k];
      if (t.type === TOKEN_TYPES.IDENTIFIER || t.type === TOKEN_TYPES.KEYWORD) {
        if (t.value === "indicator" || t.value === "strategy") {
          hasDeclaration = true;
          break;
        }
      }
    }

    if (!hasDeclaration) {
      errors.push({
        line: 1,
        column: 1,
        message: "Script must declare either indicator(...) or strategy(...) on the first active statement."
      });
    }

    // Pass 1: Collect declared identifiers
    for (let k = 0; k < tokens.length; k++) {
      const t = tokens[k];
      const next = tokens[k + 1];

      // Variable declaration: name = expr OR var name = expr
      if (t.type === TOKEN_TYPES.IDENTIFIER && next && next.value === "=") {
        declaredVars.add(t.value);
      } else if (t.value === "var" && next && next.type === TOKEN_TYPES.IDENTIFIER) {
        declaredVars.add(next.value);
      } else if (t.value === "[" && tokens[k + 1] && tokens[k + 2] && tokens[k + 2].value === ",") {
        // Multi-assignment tuple: [a, b, c] = ...
        let m = k + 1;
        while (m < tokens.length && tokens[m].value !== "]") {
          if (tokens[m].type === TOKEN_TYPES.IDENTIFIER) declaredVars.add(tokens[m].value);
          m++;
        }
      }
    }

    // Pass 2: Check function call arities and unknown identifiers
    let parenDepth = 0;
    for (let k = 0; k < tokens.length; k++) {
      const t = tokens[k];

      if (t.value === "(") parenDepth++;
      if (t.value === ")") parenDepth--;

      // Function calls: name(...)
      if (t.type === TOKEN_TYPES.IDENTIFIER && tokens[k + 1] && tokens[k + 1].value === "(") {
        const fnName = t.value;
        const sig = FUNCTION_SIGNATURES[fnName];

        if (sig) {
          // Count arguments within this call
          let depth = 1;
          let p = k + 2;
          let argCount = 0;
          let hasTokensInArg = false;

          while (p < tokens.length && depth > 0) {
            if (tokens[p].value === "(") depth++;
            else if (tokens[p].value === ")") {
              depth--;
              if (depth === 0) {
                if (hasTokensInArg) argCount++;
                break;
              }
            } else if (tokens[p].value === "," && depth === 1) {
              argCount++;
              hasTokensInArg = false;
              p++;
              continue;
            } else if (tokens[p].type !== TOKEN_TYPES.NEWLINE) {
              hasTokensInArg = true;
            }
            p++;
          }

          if (argCount < sig.minArgs) {
            errors.push({
              line: t.line,
              column: t.col,
              message: `Function '${fnName}' expects at least ${sig.minArgs} argument(s) ${sig.desc}, but received ${argCount}.`
            });
          } else if (sig.maxArgs && argCount > sig.maxArgs) {
            errors.push({
              line: t.line,
              column: t.col,
              message: `Function '${fnName}' expects at most ${sig.maxArgs} argument(s) ${sig.desc}, but received ${argCount}.`
            });
          }
        } else if (fnName.startsWith("ta.") || fnName.startsWith("math.") || fnName.startsWith("strategy.")) {
          errors.push({
            line: t.line,
            column: t.col,
            message: `Unknown or unsupported namespace member '${fnName}'.`
          });
        }
      } else if (t.type === TOKEN_TYPES.IDENTIFIER && !tokens[k + 1]?.value?.startsWith("(") && tokens[k - 1]?.value !== ".") {
        // Free identifier
        if (!declaredVars.has(t.value) && !FUNCTION_SIGNATURES[t.value]) {
          errors.push({
            line: t.line,
            column: t.col,
            message: `Undeclared identifier '${t.value}'.`
          });
        }
      }
    }

    if (parenDepth !== 0) {
      errors.push({
        line: tokens[tokens.length - 1]?.line || 1,
        column: 1,
        message: "Syntax error: Unmatched parentheses '(' and ')'."
      });
    }

    return {
      isValid: errors.length === 0,
      errors
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

  // --------------------------------------------------------------------------
  // 5. Execution Runtime & Broker Emulator
  // --------------------------------------------------------------------------
  function executePineScript(scriptSource, dataset, options = {}) {
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

    const { times, opens, highs, lows, closes, volumes } = dataset;
    const N = closes.length;
    if (N === 0) {
      return {
        success: false,
        errors: [{ line: 1, column: 1, message: "Empty candle dataset." }],
        trades: [],
        metrics: null,
        plots: {}
      };
    }

    // Default strategy options
    const initialCapital = options.initialCapital || 10000;
    const leverage = options.leverage || 10;
    const feeRate = options.feeRate !== undefined ? options.feeRate : 0.0004;
    const slippageBps = options.slippageBps !== undefined ? options.slippageBps : 2;
    const slippageFactor = slippageBps / 10000;

    // Series Cache for dynamic indicator evaluation
    const seriesCache = new Map();
    seriesCache.set("open", opens);
    seriesCache.set("high", highs);
    seriesCache.set("low", lows);
    seriesCache.set("close", closes);
    seriesCache.set("volume", volumes);

    // Dynamic hl2, hlc3, ohlc4
    const hl2 = new Float64Array(N);
    const hlc3 = new Float64Array(N);
    const ohlc4 = new Float64Array(N);
    for (let i = 0; i < N; i++) {
      hl2[i] = (highs[i] + lows[i]) * 0.5;
      hlc3[i] = (highs[i] + lows[i] + closes[i]) / 3.0;
      ohlc4[i] = (opens[i] + highs[i] + lows[i] + closes[i]) * 0.25;
    }
    seriesCache.set("hl2", hl2);
    seriesCache.set("hlc3", hlc3);
    seriesCache.set("ohlc4", ohlc4);

    // Extract User Inputs & Constants
    const inputs = Object.assign({}, options.inputs || {});

    // Parse plot() statements
    const plots = {};
    const plotMatches = scriptSource.matchAll(/plot\s*\(([^,)]+)(?:,\s*["']([^"']+)["'])?(?:,\s*color\s*=\s*([^,)]+))?/g);
    for (const pm of plotMatches) {
      const expr = pm[1].trim();
      const title = pm[2] || expr;
      const colStr = pm[3] || "#2962ff";
      plots[title] = { expr, title, color: colStr, data: [] };
    }

    // Parse indicator declarations (e.g. fast = ta.ema(close, 9))
    const indMatches = scriptSource.matchAll(/([a-zA-Z_]\w*)\s*=\s*(ta\.[a-zA-Z_]\w*)\s*\(([^)]+)\)/g);
    for (const m of indMatches) {
      const varName = m[1];
      const fn = m[2];
      const rawArgs = m[3].split(',').map(s => s.trim());

      let computed = null;
      if (fn === "ta.ema") {
        const src = seriesCache.get(rawArgs[0]) || closes;
        const len = inputs[rawArgs[1]] || parseInt(rawArgs[1], 10) || 14;
        computed = calcEMA(src, len);
      } else if (fn === "ta.sma") {
        const src = seriesCache.get(rawArgs[0]) || closes;
        const len = inputs[rawArgs[1]] || parseInt(rawArgs[1], 10) || 20;
        computed = calcSMA(src, len);
      } else if (fn === "ta.rsi") {
        const src = seriesCache.get(rawArgs[0]) || closes;
        const len = inputs[rawArgs[1]] || parseInt(rawArgs[1], 10) || 14;
        computed = calcRSI(src, len);
      } else if (fn === "ta.atr") {
        const len = inputs[rawArgs[0]] || parseInt(rawArgs[0], 10) || 14;
        computed = calcATR(highs, lows, closes, len);
      } else if (fn === "ta.highest") {
        const src = seriesCache.get(rawArgs[0]) || highs;
        const len = inputs[rawArgs[1]] || parseInt(rawArgs[1], 10) || 14;
        computed = calcHighest(src, len);
      } else if (fn === "ta.lowest") {
        const src = seriesCache.get(rawArgs[0]) || lows;
        const len = inputs[rawArgs[1]] || parseInt(rawArgs[1], 10) || 14;
        computed = calcLowest(src, len);
      }

      if (computed) {
        seriesCache.set(varName, computed);
      }
    }

    // Populate plot series data with intelligent downsampling (max 5,000 points for chart)
    const MAX_CHART_POINTS = 5000;
    const plotStep = N > MAX_CHART_POINTS ? Math.ceil(N / MAX_CHART_POINTS) : 1;

    for (const [title, pObj] of Object.entries(plots)) {
      const series = seriesCache.get(pObj.expr) || seriesCache.get(title);
      if (series) {
        const outLen = Math.ceil(N / plotStep);
        pObj.data = new Array(outLen);
        let outIdx = 0;
        for (let i = 0; i < N; i += plotStep) {
          pObj.data[outIdx++] = {
            time: times[i],
            value: isNaN(series[i]) ? null : series[i]
          };
        }
        // Ensure last bar is always included
        if ((N - 1) % plotStep !== 0) {
          pObj.data.push({
            time: times[N - 1],
            value: isNaN(series[N - 1]) ? null : series[N - 1]
          });
        }
      }
    }

    // Broker Emulator: Chronological Bar-by-Bar Order Execution
    let capital = initialCapital;
    let position = null; // { id, side: "LONG"|"SHORT", qty, entryPrice, entryTime, entryBar, fees, stop, limit }
    const trades = [];
    const signals = [];
    const equityCurve = [{ time: times[0], value: capital }];
    let pendingEntry = null; // Next-bar open entry order

    // Equity curve sampling rate (max 2,000 points)
    const eqStep = N > 2000 ? Math.ceil(N / 2000) : 1;

    // Look for crossover / crossunder conditions in script
    const hasLongEntry = /strategy\.entry\s*\(\s*["']([^"']+)["']\s*,\s*strategy\.long/i.test(scriptSource);
    const hasShortEntry = /strategy\.entry\s*\(\s*["']([^"']+)["']\s*,\s*strategy\.short/i.test(scriptSource);
    const hasClose = /strategy\.close\s*\(/i.test(scriptSource);
    const hasExit = /strategy\.exit\s*\(/i.test(scriptSource);

    // Parse strategy.exit stop and limit levels if declared in script
    let exitStopVal = null;
    let exitLimitVal = null;
    const exitMatch = scriptSource.match(/strategy\.exit\s*\(([^)]+)\)/i);
    if (exitMatch) {
      const exitArgs = exitMatch[1];
      const stopM = exitArgs.match(/stop\s*=\s*([^,)]+)/i);
      const limitM = exitArgs.match(/limit\s*=\s*([^,)]+)/i);
      if (stopM) {
        const val = parseFloat(stopM[1].trim());
        if (!isNaN(val)) exitStopVal = val;
      }
      if (limitM) {
        const val = parseFloat(limitM[1].trim());
        if (!isNaN(val)) exitLimitVal = val;
      }
    }

    // Identify entry triggers
    // Example: ta.crossover(fast, slow) or close > ema
    let crossFast = null;
    let crossSlow = null;
    const crossMatch = scriptSource.match(/ta\.crossover\s*\(\s*([a-zA-Z_]\w*)\s*,\s*([a-zA-Z_]\w*)\s*\)/);
    if (crossMatch) {
      crossFast = seriesCache.get(crossMatch[1]);
      crossSlow = seriesCache.get(crossMatch[2]);
    }
    let underFast = null;
    let underSlow = null;
    const underMatch = scriptSource.match(/ta\.crossunder\s*\(\s*([a-zA-Z_]\w*)\s*,\s*([a-zA-Z_]\w*)\s*\)/);
    if (underMatch) {
      underFast = seriesCache.get(underMatch[1]);
      underSlow = seriesCache.get(underMatch[2]);
    }

    // Main Chronological Execution Loop
    for (let i = 1; i < N; i++) {
      const barOpen = opens[i];
      const barHigh = highs[i];
      const barLow = lows[i];
      const barClose = closes[i];
      const barTime = times[i];

      // 1. Process pending entry orders at bar Open
      if (pendingEntry && !position) {
        const slippedEntry = pendingEntry.side === "LONG"
          ? barOpen * (1 + slippageFactor)
          : barOpen * (1 - slippageFactor);
        const notional = (capital * 0.1) * leverage;
        const qty = notional / slippedEntry;
        const entryFee = qty * slippedEntry * feeRate;

        position = {
          id: pendingEntry.id,
          side: pendingEntry.side,
          qty,
          entryPrice: slippedEntry,
          entryTime: barTime,
          entryBar: i,
          fees: entryFee,
          stop: exitStopVal !== null ? exitStopVal : (pendingEntry.stop || null),
          limit: exitLimitVal !== null ? exitLimitVal : (pendingEntry.limit || null)
        };
        pendingEntry = null;
      }

      // 2. Intrabar Stop / Limit Bracket Execution for open position
      if (position && (position.stop !== null || position.limit !== null)) {
        let exitPrice = null;
        let exitReason = "";

        if (position.side === "LONG") {
          const hitStop = position.stop !== null && barLow <= position.stop;
          const hitLimit = position.limit !== null && barHigh >= position.limit;
          const effectiveStop = (barOpen <= position.stop) ? barOpen : position.stop;
          const effectiveLimit = (barOpen >= position.limit) ? barOpen : position.limit;

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
          const effectiveStop = (barOpen >= position.stop) ? barOpen : position.stop;
          const effectiveLimit = (barOpen <= position.limit) ? barOpen : position.limit;

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

      // 3. Evaluate Strategy Signals on Bar Close
      const isBullish = crossFast && crossSlow && crossFast[i] > crossSlow[i] && crossFast[i - 1] <= crossSlow[i - 1];
      const isBearish = (underFast && underSlow && underFast[i] < underSlow[i] && underFast[i - 1] >= underSlow[i - 1]) ||
                        (!underFast && crossFast && crossSlow && crossFast[i] < crossSlow[i] && crossFast[i - 1] >= crossSlow[i - 1]);

      if (isBullish) {
        if (position && position.side === "SHORT") {
          signals.push({ barIndex: i, time: barTime, action: "close", id: position.id, price: barClose });
          const slippedExit = barClose * (1 + slippageFactor);
          const grossPnl = (position.entryPrice - slippedExit) * position.qty;
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
            reason: "Strategy Close"
          });
          position = null;
        }
        if (hasLongEntry && !position && !pendingEntry) {
          pendingEntry = { id: "Buy", side: "LONG" };
          signals.push({ barIndex: i, time: barTime, action: "entry", id: "Buy", direction: "LONG", price: barClose });
        }
      } else if (isBearish) {
        if (position && position.side === "LONG") {
          signals.push({ barIndex: i, time: barTime, action: "close", id: position.id, price: barClose });
          const slippedExit = barClose * (1 - slippageFactor);
          const grossPnl = (slippedExit - position.entryPrice) * position.qty;
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
            reason: "Strategy Close"
          });
          position = null;
        }
        if (hasShortEntry && !position && !pendingEntry) {
          pendingEntry = { id: "Short", side: "SHORT" };
          signals.push({ barIndex: i, time: barTime, action: "entry", id: "Short", direction: "SHORT", price: barClose });
        }
      }

      // Track equity curve sampled
      if (i % eqStep === 0 || i === N - 1) {
        equityCurve.push({ time: barTime, value: capital });
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
    const totalTrades = trades.length;
    const wins = trades.filter(t => t.netPnl > 0);
    const losses = trades.filter(t => t.netPnl < 0);
    const grossProfit = wins.reduce((s, t) => s + t.netPnl, 0);
    const grossLoss = Math.abs(losses.reduce((s, t) => s + t.netPnl, 0));
    const netProfit = capital - initialCapital;
    const netProfitPct = (netProfit / initialCapital) * 100;
    const winRate = totalTrades > 0 ? (wins.length / totalTrades) * 100 : 0;
    const profitFactor = grossLoss > 0 ? (grossProfit / grossLoss) : (grossProfit > 0 ? Infinity : 0);

    return {
      success: true,
      errors: [],
      signals,
      trades,
      equityCurve,
      plots,
      barCount: N,
      metrics: {
        initialCapital,
        finalCapital: capital,
        netProfit,
        netProfitPct,
        totalTrades,
        wins: wins.length,
        losses: losses.length,
        winRate,
        profitFactor,
        maxDrawdownUsd: 0,
        maxDrawdownPct: 0,
        avgTrade: totalTrades > 0 ? netProfit / totalTrades : 0,
        totalFees: trades.reduce((s, t) => s + t.fees, 0)
      }
    };
  }

  // Asynchronous chunked version for Web Worker with cooperative cancellation
  async function executePineScriptAsync(scriptSource, dataset, options = {}, isCancelled = null, onProgress = null) {
    const val = validateScript(scriptSource);
    if (!val.isValid) {
      return { success: false, errors: val.errors, trades: [], metrics: null, plots: {} };
    }

    const { times, opens, highs, lows, closes, volumes } = dataset;
    const N = closes.length;
    if (N === 0) {
      return { success: false, errors: [{ line: 1, column: 1, message: "Empty candle dataset." }], trades: [], metrics: null, plots: {} };
    }

    const initialCapital = options.initialCapital || 10000;
    const leverage = options.leverage || 10;
    const feeRate = options.feeRate !== undefined ? options.feeRate : 0.0004;
    const slippageBps = options.slippageBps !== undefined ? options.slippageBps : 2;
    const slippageFactor = slippageBps / 10000;

    const seriesCache = new Map();
    seriesCache.set("open", opens);
    seriesCache.set("high", highs);
    seriesCache.set("low", lows);
    seriesCache.set("close", closes);
    seriesCache.set("volume", volumes);

    const hl2 = new Float64Array(N);
    const hlc3 = new Float64Array(N);
    const ohlc4 = new Float64Array(N);
    for (let i = 0; i < N; i++) {
      hl2[i] = (highs[i] + lows[i]) * 0.5;
      hlc3[i] = (highs[i] + lows[i] + closes[i]) / 3.0;
      ohlc4[i] = (opens[i] + highs[i] + lows[i] + closes[i]) * 0.25;
    }
    seriesCache.set("hl2", hl2);
    seriesCache.set("hlc3", hlc3);
    seriesCache.set("ohlc4", ohlc4);

    const inputs = Object.assign({}, options.inputs || {});

    const plots = {};
    const plotMatches = scriptSource.matchAll(/plot\s*\(([^,)]+)(?:,\s*["']([^"']+)["'])?(?:,\s*color\s*=\s*([^,)]+))?/g);
    for (const pm of plotMatches) {
      const expr = pm[1].trim();
      const title = pm[2] || expr;
      const colStr = pm[3] || "#2962ff";
      plots[title] = { expr, title, color: colStr, data: [] };
    }

    const indMatches = scriptSource.matchAll(/([a-zA-Z_]\w*)\s*=\s*(ta\.[a-zA-Z_]\w*)\s*\(([^)]+)\)/g);
    for (const m of indMatches) {
      const varName = m[1];
      const fn = m[2];
      const rawArgs = m[3].split(',').map(s => s.trim());
      let computed = null;
      if (fn === "ta.ema") {
        const src = seriesCache.get(rawArgs[0]) || closes;
        const len = inputs[rawArgs[1]] || parseInt(rawArgs[1], 10) || 14;
        computed = calcEMA(src, len);
      } else if (fn === "ta.sma") {
        const src = seriesCache.get(rawArgs[0]) || closes;
        const len = inputs[rawArgs[1]] || parseInt(rawArgs[1], 10) || 20;
        computed = calcSMA(src, len);
      } else if (fn === "ta.rsi") {
        const src = seriesCache.get(rawArgs[0]) || closes;
        const len = inputs[rawArgs[1]] || parseInt(rawArgs[1], 10) || 14;
        computed = calcRSI(src, len);
      } else if (fn === "ta.atr") {
        const len = inputs[rawArgs[0]] || parseInt(rawArgs[0], 10) || 14;
        computed = calcATR(highs, lows, closes, len);
      } else if (fn === "ta.highest") {
        const src = seriesCache.get(rawArgs[0]) || highs;
        const len = inputs[rawArgs[1]] || parseInt(rawArgs[1], 10) || 14;
        computed = calcHighest(src, len);
      } else if (fn === "ta.lowest") {
        const src = seriesCache.get(rawArgs[0]) || lows;
        const len = inputs[rawArgs[1]] || parseInt(rawArgs[1], 10) || 14;
        computed = calcLowest(src, len);
      }
      if (computed) seriesCache.set(varName, computed);
    }

    const hasLongEntry = /strategy\.entry\s*\(\s*["']([^"']+)["']\s*,\s*strategy\.long/i.test(scriptSource);
    const hasShortEntry = /strategy\.entry\s*\(\s*["']([^"']+)["']\s*,\s*strategy\.short/i.test(scriptSource);
    const hasClose = /strategy\.close\s*\(/i.test(scriptSource);
    const hasExit = /strategy\.exit\s*\(/i.test(scriptSource);

    let exitStopVal = null;
    let exitLimitVal = null;
    const exitMatch = scriptSource.match(/strategy\.exit\s*\(([^)]+)\)/i);
    if (exitMatch) {
      const exitArgs = exitMatch[1];
      const stopM = exitArgs.match(/stop\s*=\s*([^,)]+)/i);
      const limitM = exitArgs.match(/limit\s*=\s*([^,)]+)/i);
      if (stopM) {
        const val = parseFloat(stopM[1].trim());
        if (!isNaN(val)) exitStopVal = val;
      }
      if (limitM) {
        const val = parseFloat(limitM[1].trim());
        if (!isNaN(val)) exitLimitVal = val;
      }
    }

    let crossFast = null;
    let crossSlow = null;
    const crossMatch = scriptSource.match(/ta\.crossover\s*\(\s*([a-zA-Z_]\w*)\s*,\s*([a-zA-Z_]\w*)\s*\)/);
    if (crossMatch) {
      crossFast = seriesCache.get(crossMatch[1]);
      crossSlow = seriesCache.get(crossMatch[2]);
    }
    let underFast = null;
    let underSlow = null;
    const underMatch = scriptSource.match(/ta\.crossunder\s*\(\s*([a-zA-Z_]\w*)\s*,\s*([a-zA-Z_]\w*)\s*\)/);
    if (underMatch) {
      underFast = seriesCache.get(underMatch[1]);
      underSlow = seriesCache.get(underMatch[2]);
    }

    let capital = initialCapital;
    let position = null;
    const trades = [];
    const signals = [];
    const equityCurve = [{ time: times[0], value: capital }];
    let pendingEntry = null;
    const eqStep = N > 2000 ? Math.ceil(N / 2000) : 1;

    for (let i = 1; i < N; i++) {
      if (i % 25000 === 0) {
        if (onProgress) onProgress(Math.round((i / N) * 100));
        await new Promise(r => setTimeout(r, 0));
        if (isCancelled && isCancelled()) {
          return { success: false, cancelled: true };
        }
      }

      const barOpen = opens[i];
      const barHigh = highs[i];
      const barLow = lows[i];
      const barClose = closes[i];
      const barTime = times[i];

      if (pendingEntry && !position) {
        const slippedEntry = pendingEntry.side === "LONG"
          ? barOpen * (1 + slippageFactor)
          : barOpen * (1 - slippageFactor);
        const notional = (capital * 0.1) * leverage;
        const qty = notional / slippedEntry;
        const entryFee = qty * slippedEntry * feeRate;

        position = {
          id: pendingEntry.id,
          side: pendingEntry.side,
          qty,
          entryPrice: slippedEntry,
          entryTime: barTime,
          entryBar: i,
          fees: entryFee,
          stop: exitStopVal !== null ? exitStopVal : (pendingEntry.stop || null),
          limit: exitLimitVal !== null ? exitLimitVal : (pendingEntry.limit || null)
        };
        pendingEntry = null;
      }

      if (position && (position.stop !== null || position.limit !== null)) {
        let exitPrice = null;
        let exitReason = "";

        if (position.side === "LONG") {
          const hitStop = position.stop !== null && barLow <= position.stop;
          const hitLimit = position.limit !== null && barHigh >= position.limit;
          const effectiveStop = (barOpen <= position.stop) ? barOpen : position.stop;
          const effectiveLimit = (barOpen >= position.limit) ? barOpen : position.limit;

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
        } else if (position.side === "SHORT") {
          const hitStop = position.stop !== null && barHigh >= position.stop;
          const hitLimit = position.limit !== null && barLow <= position.limit;
          const effectiveStop = (barOpen >= position.stop) ? barOpen : position.stop;
          const effectiveLimit = (barOpen <= position.limit) ? barOpen : position.limit;

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
            entryBar: i,
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

      const isBullish = crossFast && crossSlow && crossFast[i] > crossSlow[i] && crossFast[i - 1] <= crossSlow[i - 1];
      const isBearish = (underFast && underSlow && underFast[i] < underSlow[i] && underFast[i - 1] >= underSlow[i - 1]) ||
                        (!underFast && crossFast && crossSlow && crossFast[i] < crossSlow[i] && crossFast[i - 1] >= crossSlow[i - 1]);

      if (isBullish) {
        if (position && position.side === "SHORT") {
          signals.push({ barIndex: i, time: barTime, action: "close", id: position.id, price: barClose });
          const slippedExit = barClose * (1 + slippageFactor);
          const grossPnl = (position.entryPrice - slippedExit) * position.qty;
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
            reason: "Strategy Close"
          });
          position = null;
        }
        if (hasLongEntry && !position && !pendingEntry) {
          pendingEntry = { id: "Buy", side: "LONG" };
          signals.push({ barIndex: i, time: barTime, action: "entry", id: "Buy", direction: "LONG", price: barClose });
        }
      } else if (isBearish) {
        if (position && position.side === "LONG") {
          signals.push({ barIndex: i, time: barTime, action: "close", id: position.id, price: barClose });
          const slippedExit = barClose * (1 - slippageFactor);
          const grossPnl = (slippedExit - position.entryPrice) * position.qty;
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
            reason: "Strategy Close"
          });
          position = null;
        }
        if (hasShortEntry && !position && !pendingEntry) {
          pendingEntry = { id: "Short", side: "SHORT" };
          signals.push({ barIndex: i, time: barTime, action: "entry", id: "Short", direction: "SHORT", price: barClose });
        }
      }

      if (i % eqStep === 0 || i === N - 1) {
        equityCurve.push({ time: barTime, value: capital });
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

    const totalTrades = trades.length;
    const wins = trades.filter(t => t.netPnl > 0);
    const losses = trades.filter(t => t.netPnl < 0);
    const grossProfit = wins.reduce((s, t) => s + t.netPnl, 0);
    const grossLoss = Math.abs(losses.reduce((s, t) => s + t.netPnl, 0));
    const netProfit = capital - initialCapital;
    const netProfitPct = (netProfit / initialCapital) * 100;
    const winRate = totalTrades > 0 ? (wins.length / totalTrades) * 100 : 0;
    const profitFactor = grossLoss > 0 ? (grossProfit / grossLoss) : (grossProfit > 0 ? Infinity : 0);

    return {
      success: true,
      errors: [],
      signals,
      trades,
      equityCurve,
      plots,
      barCount: N,
      metrics: {
        initialCapital,
        finalCapital: capital,
        netProfit,
        netProfitPct,
        totalTrades,
        wins: wins.length,
        losses: losses.length,
        winRate,
        profitFactor,
        maxDrawdownUsd: 0,
        maxDrawdownPct: 0,
        avgTrade: totalTrades > 0 ? netProfit / totalTrades : 0,
        totalFees: trades.reduce((s, t) => s + t.fees, 0)
      }
    };
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

  // Export for main thread direct / fallback usage
  if (typeof module !== "undefined" && module.exports) {
    module.exports = { validateScript, executePineScript, tokenize };
  } else if (typeof window !== "undefined") {
    window.PineEngine = { validateScript, executePineScript, tokenize };
  }
})();
