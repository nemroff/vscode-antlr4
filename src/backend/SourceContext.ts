/*
 * This file is released under the MIT license.
 * Copyright (c) 2016, 2022, Mike Lischke
 *
 * See LICENSE file for more info.
 */

// This file contains the handling for a single source file. It provides syntactic and semantic
// information, symbol lookups and more.

import * as child_process from "child_process";
import * as path from "path";
import * as fs from "fs";
import * as vm from "vm";

import {
    CharStreams, CommonTokenStream, BailErrorStrategy, DefaultErrorStrategy, Token, RuleContext, ParserRuleContext,
    Vocabulary,
} from "antlr4ts";
import {
    PredictionMode, ATNState, RuleTransition, TransitionType, ATNStateType, RuleStartState, ActionTransition,
    PredicateTransition, PrecedencePredicateTransition,
} from "antlr4ts/atn";
import { ParseCancellationException, IntervalSet, Interval } from "antlr4ts/misc";
import { ParseTreeWalker, TerminalNode, ParseTree } from "antlr4ts/tree";

import { CodeCompletionCore, Symbol, LiteralSymbol } from "antlr4-c3";

import {
    ANTLRv4Parser, ParserRuleSpecContext, LexerRuleSpecContext, GrammarSpecContext, OptionsSpecContext, ModeSpecContext,
} from "../parser/ANTLRv4Parser";
import { ANTLRv4Lexer } from "../parser/ANTLRv4Lexer";

import {
    ISymbolInfo, IDiagnosticEntry, DiagnosticType, IReferenceNode, IAtnGraphData, IGenerationOptions,
    ISentenceGenerationOptions, IFormattingOptions, IDefinition, IContextDetails, PredicateFunction, IAtnLink,
    CodeActionType, SymbolKind, GrammarType,
} from "./types";

import { ContextErrorListener } from "./ContextErrorListener";
import { ContextLexerErrorListener } from "./ContextLexerErrorListener";

import { DetailsListener } from "./DetailsListener";
import { SemanticListener } from "./SemanticListener";
import { RuleVisitor } from "./RuleVisitor";
import { InterpreterDataReader, IInterpreterData } from "./InterpreterDataReader";
import { ErrorParser } from "./ErrorParser";

import {
    ContextSymbolTable, BuiltInChannelSymbol, BuiltInTokenSymbol, BuiltInModeSymbol, RuleSymbol,
    VirtualTokenSymbol, FragmentTokenSymbol, TokenSymbol, RuleReferenceSymbol, TokenReferenceSymbol, ImportSymbol,
    LexerModeSymbol, TokenChannelSymbol, OperatorSymbol, ArgumentsSymbol, ExceptionActionSymbol,
    FinallyActionSymbol, LexerActionSymbol, LexerPredicateSymbol, ParserActionSymbol,
    ParserPredicateSymbol,
    LexerCommandSymbol,
    TerminalSymbol,
    GlobalNamedActionSymbol,
    LocalNamedActionSymbol,
} from "./ContextSymbolTable";

import { SentenceGenerator } from "./SentenceGenerator";
import { GrammarFormatter } from "./Formatter";
import {
    GrammarLexerInterpreter, InterpreterLexerErrorListener, GrammarParserInterpreter, InterpreterParserErrorListener,
} from "./GrammarInterpreters";
import { printableUnicodePoints } from "./Unicode";
import { BackendUtils } from "./BackendUtils";

// One source context per file. Source contexts can reference each other (e.g. for symbol lookups).
export class SourceContext {
    private static globalSymbols = new ContextSymbolTable("Global Symbols", { allowDuplicateSymbols: false });
    private static symbolToKindMap: Map<new () => Symbol, SymbolKind> = new Map([
        [GlobalNamedActionSymbol, SymbolKind.GlobalNamedAction],
        [LocalNamedActionSymbol, SymbolKind.LocalNamedAction],
        [ImportSymbol, SymbolKind.Import],
        [BuiltInTokenSymbol, SymbolKind.BuiltInLexerToken],
        [VirtualTokenSymbol, SymbolKind.VirtualLexerToken],
        [FragmentTokenSymbol, SymbolKind.FragmentLexerToken],
        [TokenSymbol, SymbolKind.LexerRule],
        [BuiltInModeSymbol, SymbolKind.BuiltInMode],
        [LexerModeSymbol, SymbolKind.LexerMode],
        [BuiltInChannelSymbol, SymbolKind.BuiltInChannel],
        [TokenChannelSymbol, SymbolKind.TokenChannel],
        [RuleSymbol, SymbolKind.ParserRule],
        [OperatorSymbol, SymbolKind.Operator],
        [TerminalSymbol, SymbolKind.Terminal],
        [TokenReferenceSymbol, SymbolKind.TokenReference],
        [RuleReferenceSymbol, SymbolKind.RuleReference],
        [LexerCommandSymbol, SymbolKind.LexerCommand],

        [ExceptionActionSymbol, SymbolKind.ExceptionAction],
        [FinallyActionSymbol, SymbolKind.FinallyAction],
        [ParserActionSymbol, SymbolKind.ParserAction],
        [LexerActionSymbol, SymbolKind.LexerAction],
        [ParserPredicateSymbol, SymbolKind.ParserPredicate],
        [LexerPredicateSymbol, SymbolKind.LexerPredicate],
        [ArgumentsSymbol, SymbolKind.Arguments],
    ]);

    private static printableChars = printableUnicodePoints({});

    public symbolTable: ContextSymbolTable;
    public sourceId: string;
    public info: IContextDetails = {
        type: GrammarType.Unknown,
        unreferencedRules: [],
        imports: [],
    };

    /* @internal */
    public diagnostics: IDiagnosticEntry[] = [];

    // eslint-disable-next-line no-use-before-define
    private references: SourceContext[] = []; // Contexts referencing us.

    // Result related fields.
    //private diagnostics: DiagnosticEntry[] = [];
    private rrdScripts: Map<string, string>;
    private semanticAnalysisDone = false; // Includes determining reference counts.

    // Grammar parsing infrastructure.
    private tokenStream: CommonTokenStream;
    private parser: ANTLRv4Parser | undefined;
    private errorListener: ContextErrorListener = new ContextErrorListener(this.diagnostics);
    private lexerErrorListener: ContextLexerErrorListener = new ContextLexerErrorListener(this.diagnostics);

    // Grammar data.
    private grammarLexerData: IInterpreterData | undefined;
    private grammarLexerRuleMap = new Map<string, number>(); // A mapping from lexer rule names to their index.
    private grammarParserData: IInterpreterData | undefined;
    private grammarParserRuleMap = new Map<string, number>(); // A mapping from parser rule names to their index.

    private tree: GrammarSpecContext | undefined; // The root context from the last parse run.

    public constructor(public fileName: string, private extensionDir: string) {
        this.sourceId = path.basename(fileName, path.extname(fileName));
        this.symbolTable = new ContextSymbolTable(this.sourceId, { allowDuplicateSymbols: true }, this);

        // Initialize static global symbol table, if not yet done.
        const eof = SourceContext.globalSymbols.resolve("EOF");
        eof.then((value) => {
            if (!value) {
                SourceContext.globalSymbols.addNewSymbolOfType(BuiltInChannelSymbol, undefined,
                    "DEFAULT_TOKEN_CHANNEL");
                SourceContext.globalSymbols.addNewSymbolOfType(BuiltInChannelSymbol, undefined, "HIDDEN");
                SourceContext.globalSymbols.addNewSymbolOfType(BuiltInTokenSymbol, undefined, "EOF");
                SourceContext.globalSymbols.addNewSymbolOfType(BuiltInModeSymbol, undefined, "DEFAULT_MODE");
            }
        }).catch(() => {
            // ignore
        });
    }

    public get isInterpreterDataLoaded(): boolean {
        return this.grammarLexerData !== undefined || this.grammarParserData !== undefined;
    }

    /**
     * Internal function to provide interpreter data to certain internal classes (e.g. the debugger).
     *
     * @returns Lexer and parser interpreter data for use outside of this context.
     */
    public get interpreterData(): [IInterpreterData | undefined, IInterpreterData | undefined] {
        return [this.grammarLexerData, this.grammarParserData];
    }

    public get hasErrors(): boolean {
        for (const diagnostic of this.diagnostics) {
            if (diagnostic.type === DiagnosticType.Error) {
                return true;
            }
        }

        return false;
    }

    public static getKindFromSymbol(symbol: Symbol): SymbolKind {
        if (symbol.name === "tokenVocab") {
            return SymbolKind.TokenVocab;
        }

        return this.symbolToKindMap.get(symbol.constructor as typeof Symbol) || SymbolKind.Unknown;
    }

    /**
     * @param ctx The context to get info for.
     * @param keepQuotes A flag indicating if quotes should be kept if there are any around the context's text.
     *
     * @returns The definition info for the given rule context.
     */
    public static definitionForContext(ctx: ParseTree | undefined, keepQuotes: boolean): IDefinition | undefined {
        if (!ctx) {
            return undefined;
        }

        const result: IDefinition = {
            text: "",
            range: {
                start: { column: 0, row: 0 },
                end: { column: 0, row: 0 },
            },
        };

        if (ctx instanceof ParserRuleContext) {
            const range = <Interval>{ a: ctx.start.startIndex, b: ctx.stop!.stopIndex };

            result.range.start.column = ctx.start.charPositionInLine;
            result.range.start.row = ctx.start.line;
            result.range.end.column = ctx.stop!.charPositionInLine;
            result.range.end.row = ctx.stop!.line;

            // For mode definitions we only need the init line, not all the lexer rules following it.
            if (ctx.ruleIndex === ANTLRv4Parser.RULE_modeSpec) {
                const modeSpec = ctx as ModeSpecContext;
                range.b = modeSpec.SEMI().symbol.stopIndex;
                result.range.end.column = modeSpec.SEMI().symbol.charPositionInLine;
                result.range.end.row = modeSpec.SEMI().symbol.line;
            } else if (ctx.ruleIndex === ANTLRv4Parser.RULE_grammarSpec) {
                // Similar for entire grammars. We only need the introducer line here.
                const grammarSpec: GrammarSpecContext = <GrammarSpecContext>ctx;
                range.b = grammarSpec.SEMI().symbol.stopIndex;
                result.range.end.column = grammarSpec.SEMI().symbol.charPositionInLine;
                result.range.end.row = grammarSpec.SEMI().symbol.line;

                range.a = grammarSpec.grammarType().start.startIndex;
                result.range.start.column = grammarSpec.grammarType().start.charPositionInLine;
                result.range.start.row = grammarSpec.grammarType().start.line;
            }

            if (ctx.start.tokenSource?.inputStream) {
                const stream = ctx.start.tokenSource.inputStream;
                try {
                    result.text = stream.getText(range);
                } catch (e) {
                    // The method getText uses an unreliable JS String API which can throw on larger texts.
                    // In this case we cannot return the text of the given context.
                    // A context with such a large size is probably an error case anyway (unfinished multi line comment
                    // or unfinished action).
                }
            }
        } else if (ctx instanceof TerminalNode) {
            result.text = ctx.text;

            result.range.start.column = ctx.symbol.charPositionInLine;
            result.range.start.row = ctx.symbol.line;
            result.range.end.column = ctx.symbol.charPositionInLine + result.text.length;
            result.range.end.row = ctx.symbol.line;
        }

        if (keepQuotes || result.text.length < 2) {
            return result;
        }

        const quoteChar = result.text[0];
        if ((quoteChar === '"' || quoteChar === "`" || quoteChar === "'")
            && quoteChar === result.text[result.text.length - 1]) {
            result.text = result.text.substr(1, result.text.length - 2);
        }

        return result;
    }

    public symbolAtPosition(column: number, row: number, limitToChildren: boolean): ISymbolInfo | undefined {

        const terminal = BackendUtils.parseTreeFromPosition(this.tree!, column, row);
        if (!terminal || !(terminal instanceof TerminalNode)) {
            return undefined;
        }

        // If limitToChildren is set we only want to show info for symbols in specific contexts.
        // These are contexts which are used as subrules in rule definitions.
        if (!limitToChildren) {
            return this.getSymbolInfo(terminal.text);
        }

        let parent = (terminal.parent as RuleContext);
        if (parent.ruleIndex === ANTLRv4Parser.RULE_identifier) {
            parent = (parent.parent as RuleContext);
        }

        switch (parent.ruleIndex) {
            case ANTLRv4Parser.RULE_ruleref:
            case ANTLRv4Parser.RULE_terminalRule: {
                let symbol = this.symbolTable.symbolContainingContext(terminal);
                if (symbol) {
                    // This is only the reference to a symbol. See if that symbol exists actually.
                    symbol = this.resolveSymbol(symbol.name);
                    if (symbol) {
                        return this.getSymbolInfo(symbol);
                    }
                }

                break;
            }

            case ANTLRv4Parser.RULE_actionBlock:
            case ANTLRv4Parser.RULE_ruleAction:
            case ANTLRv4Parser.RULE_lexerCommandExpr:
            case ANTLRv4Parser.RULE_optionValue:
            case ANTLRv4Parser.RULE_delegateGrammar:
            case ANTLRv4Parser.RULE_modeSpec:
            case ANTLRv4Parser.RULE_setElement: {
                const symbol = this.symbolTable.symbolContainingContext(terminal);
                if (symbol) {
                    return this.getSymbolInfo(symbol);
                }

                break;
            }

            case ANTLRv4Parser.RULE_lexerCommand:
            case ANTLRv4Parser.RULE_lexerCommandName: {
                const symbol = this.symbolTable.symbolContainingContext(terminal);
                if (symbol) {
                    return this.getSymbolInfo(symbol);
                }

                break;
            }

            default: {
                break;
            }
        }

        return undefined;
    }

    /**
     * Returns the symbol at the given position or one of its outer scopes.
     *
     * @param column The position within a source line.
     * @param row The source line index.
     * @param ruleScope If true find the enclosing rule (if any) and return it's range, instead of the directly
     *                  enclosing scope.
     *
     * @returns The symbol at the given position (if there's any).
     */
    public enclosingSymbolAtPosition(column: number, row: number, ruleScope: boolean): ISymbolInfo | undefined {
        let context = BackendUtils.parseTreeFromPosition(this.tree!, column, row);
        if (!context) {
            return undefined;
        }

        if (context instanceof TerminalNode) {
            context = context.parent;
        }

        if (ruleScope) {
            let run = context;
            while (run
                && !(run instanceof ParserRuleSpecContext)
                && !(run instanceof OptionsSpecContext)
                && !(run instanceof LexerRuleSpecContext)) {
                run = run.parent;
            }
            if (run) {
                context = run;
            }
        }

        if (context) {
            const symbol = this.symbolTable.symbolWithContextSync(context);
            if (symbol) {
                return this.symbolTable.getSymbolInfo(symbol);
            }
        }
    }

    public listTopLevelSymbols(includeDependencies: boolean): ISymbolInfo[] {
        return this.symbolTable.listTopLevelSymbols(includeDependencies);
    }

    public getVocabulary(): Vocabulary | undefined {
        if (this.grammarLexerData) {
            return this.grammarLexerData.vocabulary;
        }
    }

    public getRuleList(): string[] | undefined {
        if (this.grammarParserData) {
            return this.grammarParserData.ruleNames;
        }
    }

    public getChannels(): string[] | undefined {
        if (this.grammarLexerData) {
            return this.grammarLexerData.channels;
        }
    }

    public getModes(): string[] | undefined {
        if (this.grammarLexerData) {
            return this.grammarLexerData.modes;
        }
    }

    /**
     * Returns a list of actions of a specific kind from the context's symbol table.
     *
     * @param type The type of list to return.
     *
     * @returns The list of actions.
     */
    public listActions(type: CodeActionType): ISymbolInfo[] {
        return this.symbolTable.listActions(type);
    }

    /**
     * Returns numbers of registered actions of each kind.
     *
     * @returns An object containing the individual action counts.
     */
    public getActionCounts(): Map<CodeActionType, number> {
        return this.symbolTable.getActionCounts();
    }

    public async getCodeCompletionCandidates(column: number, row: number): Promise<ISymbolInfo[]> {
        if (!this.parser) {
            return [];
        }

        const core = new CodeCompletionCore(this.parser);
        core.showResult = false;
        core.ignoredTokens = new Set([
            ANTLRv4Lexer.TOKEN_REF,
            ANTLRv4Lexer.RULE_REF,
            ANTLRv4Lexer.LEXER_CHAR_SET,
            ANTLRv4Lexer.DOC_COMMENT,
            ANTLRv4Lexer.BLOCK_COMMENT,
            ANTLRv4Lexer.LINE_COMMENT,
            ANTLRv4Lexer.INT,
            ANTLRv4Lexer.STRING_LITERAL,
            ANTLRv4Lexer.UNTERMINATED_STRING_LITERAL,
            ANTLRv4Lexer.MODE,
            ANTLRv4Lexer.COLON,
            ANTLRv4Lexer.COLONCOLON,
            ANTLRv4Lexer.COMMA,
            ANTLRv4Lexer.SEMI,
            ANTLRv4Lexer.LPAREN,
            ANTLRv4Lexer.RPAREN,
            ANTLRv4Lexer.LBRACE,
            ANTLRv4Lexer.RBRACE,
            //ANTLRv4Lexer.RARROW,
            //ANTLRv4Lexer.LT,
            ANTLRv4Lexer.GT,
            //ANTLRv4Lexer.ASSIGN,
            //ANTLRv4Lexer.QUESTION,
            //ANTLRv4Lexer.STAR,
            //ANTLRv4Lexer.PLUS_ASSIGN,
            //ANTLRv4Lexer.PLUS,
            //ANTLRv4Lexer.OR,
            ANTLRv4Lexer.DOLLAR,
            ANTLRv4Lexer.RANGE,
            ANTLRv4Lexer.DOT,
            ANTLRv4Lexer.AT,
            ANTLRv4Lexer.POUND,
            ANTLRv4Lexer.NOT,
            ANTLRv4Lexer.ID,
            ANTLRv4Lexer.WS,
            ANTLRv4Lexer.END_ARGUMENT,
            ANTLRv4Lexer.UNTERMINATED_ARGUMENT,
            ANTLRv4Lexer.ARGUMENT_CONTENT,
            ANTLRv4Lexer.END_ACTION,
            ANTLRv4Lexer.UNTERMINATED_ACTION,
            ANTLRv4Lexer.ACTION_CONTENT,
            ANTLRv4Lexer.UNTERMINATED_CHAR_SET,
            ANTLRv4Lexer.EOF,
            -2, // TODO: Erroneously inserted. Needs fix in antlr4-c3.
        ]);

        core.preferredRules = new Set([
            ANTLRv4Parser.RULE_argActionBlock,
            ANTLRv4Parser.RULE_actionBlock,
            ANTLRv4Parser.RULE_terminalRule,
            ANTLRv4Parser.RULE_lexerCommandName,
            ANTLRv4Parser.RULE_identifier,
            ANTLRv4Parser.RULE_ruleref,
        ]);

        // Search the token index which covers our caret position.
        let index: number;
        this.tokenStream.fill();
        for (index = 0; ; ++index) {
            const token = this.tokenStream.get(index);
            //console.log(token.toString());
            if (token.type === Token.EOF || token.line > row) {
                break;
            }
            if (token.line < row) {
                continue;
            }
            const length = token.text ? token.text.length : 0;
            if ((token.charPositionInLine + length) >= column) {
                break;
            }
        }

        const candidates = core.collectCandidates(index);
        const result: ISymbolInfo[] = [];

        candidates.tokens.forEach((following: number[], type: number) => {
            switch (type) {
                case ANTLRv4Lexer.RARROW: {
                    result.push({
                        kind: SymbolKind.Operator,
                        name: "->",
                        description: "Lexer action introducer",
                        source: this.fileName,
                    });

                    break;
                }
                case ANTLRv4Lexer.LT: {
                    result.push({
                        kind: SymbolKind.Operator,
                        name: "< key = value >",
                        description: "Rule element option",
                        source: this.fileName,
                    });

                    break;
                }
                case ANTLRv4Lexer.ASSIGN: {
                    result.push({
                        kind: SymbolKind.Operator,
                        name: "=",
                        description: "Variable assignment",
                        source: this.fileName,
                    });

                    break;
                }

                case ANTLRv4Lexer.QUESTION: {
                    result.push({
                        kind: SymbolKind.Operator,
                        name: "?",
                        description: "Zero or one repetition operator",
                        source: this.fileName,
                    });
                    break;
                }

                case ANTLRv4Lexer.STAR: {
                    result.push({
                        kind: SymbolKind.Operator,
                        name: "*",
                        description: "Zero or more repetition operator",
                        source: this.fileName,
                    });

                    break;
                }

                case ANTLRv4Lexer.PLUS_ASSIGN: {
                    result.push({
                        kind: SymbolKind.Operator,
                        name: "+=",
                        description: "Variable list addition",
                        source: this.fileName,
                    });

                    break;
                }

                case ANTLRv4Lexer.PLUS: {
                    result.push({
                        kind: SymbolKind.Operator,
                        name: "+",
                        description: "One or more repetition operator",
                        source: this.fileName,
                    });

                    break;
                }

                case ANTLRv4Lexer.OR: {
                    result.push({
                        kind: SymbolKind.Operator,
                        name: "|",
                        description: "Rule alt separator",
                        source: this.fileName,
                    });
                    break;
                }

                default: {
                    const value = this.parser!.vocabulary.getDisplayName(type);
                    result.push({
                        kind: SymbolKind.Keyword,
                        name: value[0] === "'" ? value.substr(1, value.length - 2) : value, // Remove quotes.
                        source: this.fileName,
                    });

                    break;
                }
            }
        });

        const promises: Array<Promise<Symbol[] | undefined>> = [];
        candidates.rules.forEach((candidateRule, key) => {
            switch (key) {
                case ANTLRv4Parser.RULE_argActionBlock: {
                    result.push({
                        kind: SymbolKind.Arguments,
                        name: "[ argument action code ]",
                        source: this.fileName,
                        definition: undefined,
                        description: undefined,
                    });
                    break;
                }

                case ANTLRv4Parser.RULE_actionBlock: {
                    result.push({
                        kind: SymbolKind.ParserAction,
                        name: "{ action code }",
                        source: this.fileName,
                        definition: undefined,
                        description: undefined,
                    });

                    // Include predicates only when we are in a lexer or parser element.
                    const list = candidateRule.ruleList;
                    if (list[list.length - 1] === ANTLRv4Parser.RULE_lexerElement) {
                        result.push({
                            kind: SymbolKind.LexerPredicate,
                            name: "{ predicate }?",
                            source: this.fileName,
                            definition: undefined,
                            description: undefined,
                        });
                    } else if (list[list.length - 1] === ANTLRv4Parser.RULE_element) {
                        result.push({
                            kind: SymbolKind.ParserPredicate,
                            name: "{ predicate }?",
                            source: this.fileName,
                            definition: undefined,
                            description: undefined,
                        });
                    }

                    break;
                }

                case ANTLRv4Parser.RULE_terminalRule: { // Lexer rules.
                    promises.push(this.symbolTable.getAllSymbols(BuiltInTokenSymbol));
                    promises.push(this.symbolTable.getAllSymbols(VirtualTokenSymbol));
                    promises.push(this.symbolTable.getAllSymbols(TokenSymbol));

                    // Include fragment rules only when referenced from a lexer rule.
                    const list = candidateRule.ruleList;
                    if (list[list.length - 1] === ANTLRv4Parser.RULE_lexerAtom) {
                        promises.push(this.symbolTable.getAllSymbols(FragmentTokenSymbol));
                    }

                    break;
                }

                case ANTLRv4Parser.RULE_lexerCommandName: {
                    ["channel", "skip", "more", "mode", "push", "pop"].forEach((symbol) => {
                        result.push({
                            kind: SymbolKind.Keyword,
                            name: symbol,
                            source: this.fileName,
                            definition: undefined,
                            description: undefined,
                        });
                    });
                    break;
                }

                case ANTLRv4Parser.RULE_ruleref: {
                    promises.push(this.symbolTable.getAllSymbols(RuleSymbol));

                    break;
                }

                case ANTLRv4Parser.RULE_identifier: {
                    // Identifiers can be a lot of things. We only handle special cases here.
                    // More concrete identifiers should be captured by rules further up in the call chain.
                    const list = candidateRule.ruleList;
                    switch (list[list.length - 1]) {
                        case ANTLRv4Parser.RULE_option: {
                            ["superClass", "tokenVocab", "TokenLabelType", "contextSuperClass", "exportMacro"]
                                .forEach((symbol) => {
                                    result.push({
                                        kind: SymbolKind.Option,
                                        name: symbol,
                                        source: this.fileName,
                                        definition: undefined,
                                        description: undefined,
                                    });
                                });
                            break;
                        }

                        case ANTLRv4Parser.RULE_namedAction: {
                            ["header", "members", "preinclude", "postinclude", "context", "declarations", "definitions",
                                "listenerpreinclude", "listenerpostinclude", "listenerdeclarations", "listenermembers",
                                "listenerdefinitions", "baselistenerpreinclude", "baselistenerpostinclude",
                                "baselistenerdeclarations", "baselistenermembers", "baselistenerdefinitions",
                                "visitorpreinclude", "visitorpostinclude", "visitordeclarations", "visitormembers",
                                "visitordefinitions", "basevisitorpreinclude", "basevisitorpostinclude",
                                "basevisitordeclarations", "basevisitormembers", "basevisitordefinitions"]
                                .forEach((symbol) => {
                                    result.push({
                                        kind: SymbolKind.Keyword,
                                        name: symbol,
                                        source: this.fileName,
                                        definition: undefined,
                                        description: undefined,
                                    });
                                });

                            break;
                        }

                        default: {
                            break;
                        }
                    }

                    break;
                }

                default: {
                    break;
                }
            }

        });

        const symbolLists = await Promise.all(promises);
        symbolLists.forEach((symbols) => {
            if (symbols) {
                symbols.forEach((symbol) => {
                    if (symbol.name !== "EOF") {
                        result.push({
                            kind: SourceContext.getKindFromSymbol(symbol),
                            name: symbol.name,
                            source: this.fileName,
                            definition: undefined,
                            description: undefined,
                        });
                    }
                });
            }
        });

        return result;
    }

    /**
     * Should be called on every change to keep the input stream up to date, particularly for code completion.
     * This call doesn't do any expensive processing (parse() does).
     *
     * @param source The new content of the editor.
     */
    public setText(source: string): void {
        const input = CharStreams.fromString(source);
        const lexer = new ANTLRv4Lexer(input);

        // There won't be lexer errors actually. They are silently bubbled up and will cause parser errors.
        lexer.removeErrorListeners();
        lexer.addErrorListener(this.lexerErrorListener);
        this.tokenStream = new CommonTokenStream(lexer);

        // Keep the old parser around until the next parse run. Code completion could kick in before that.
        // this.parser = undefined;
    }

    public parse(): string[] {
        // Rewind the input stream for a new parse run.
        // Might be unnecessary when we just created that via setText.
        this.tokenStream.seek(0);
        this.parser = new ANTLRv4Parser(this.tokenStream);
        this.parser.removeErrorListeners();
        this.parser.addErrorListener(this.errorListener);

        this.parser.errorHandler = new BailErrorStrategy();
        this.parser.interpreter.setPredictionMode(PredictionMode.SLL);

        this.tree = undefined;

        this.info.type = GrammarType.Unknown;
        this.info.imports.length = 0;

        this.grammarLexerData = undefined;
        this.grammarLexerRuleMap.clear();
        this.grammarParserData = undefined;
        this.grammarLexerRuleMap.clear();

        this.semanticAnalysisDone = false;
        this.diagnostics.length = 0;

        this.symbolTable.clear();
        this.symbolTable.addDependencies(SourceContext.globalSymbols);

        try {
            this.tree = this.parser.grammarSpec();
        } catch (e) {
            if (e instanceof ParseCancellationException) {
                this.tokenStream.seek(0);
                this.parser.reset();
                this.parser.errorHandler = new DefaultErrorStrategy();
                this.parser.interpreter.setPredictionMode(PredictionMode.LL);
                this.tree = this.parser.grammarSpec();
            } else {
                throw e;
            }
        }

        if (this.tree && this.tree.childCount > 0) {
            try {
                const typeContext = this.tree.grammarType();
                if (typeContext.LEXER()) {
                    this.info.type = GrammarType.Lexer;
                } else if (typeContext.PARSER()) {
                    this.info.type = GrammarType.Parser;
                } else {
                    this.info.type = GrammarType.Combined;
                }
            } catch (e) {
                // ignored
            }
        }

        this.symbolTable.tree = this.tree;
        const listener = new DetailsListener(this.symbolTable, this.info.imports);
        ParseTreeWalker.DEFAULT.walk(listener, this.tree);

        this.info.unreferencedRules = this.symbolTable.getUnreferencedSymbols();

        return this.info.imports;
    }

    public getDiagnostics(): IDiagnosticEntry[] {
        this.runSemanticAnalysisIfNeeded();

        return this.diagnostics;
    }

    public async getReferenceGraph(): Promise<Map<string, IReferenceNode>> {
        this.runSemanticAnalysisIfNeeded();

        const result = new Map<string, IReferenceNode>();
        for (const symbol of await this.symbolTable.getAllSymbols(Symbol, false)) {
            if (symbol instanceof RuleSymbol
                || symbol instanceof TokenSymbol
                || symbol instanceof FragmentTokenSymbol) {
                const entry: IReferenceNode = {
                    kind: symbol instanceof RuleSymbol ? SymbolKind.ParserRule : SymbolKind.LexerRule,
                    rules: new Set<string>(),
                    tokens: new Set<string>(),
                    literals: new Set<string>(),
                };

                for (const child of await symbol.getNestedSymbolsOfType(RuleReferenceSymbol)) {
                    const resolved = await this.symbolTable.resolve(child.name, false);
                    if (resolved) {
                        entry.rules.add(resolved.qualifiedName());
                    } else {
                        entry.rules.add(child.name);
                    }
                }

                for (const child of await symbol.getNestedSymbolsOfType(TokenReferenceSymbol)) {
                    const resolved = await this.symbolTable.resolve(child.name, false);
                    if (resolved) {
                        entry.tokens.add(resolved.qualifiedName());
                    } else {
                        entry.tokens.add(child.name);
                    }
                }

                for (const child of await symbol.getNestedSymbolsOfType(LiteralSymbol)) {
                    const resolved = await this.symbolTable.resolve(child.name, false);
                    if (resolved) {
                        entry.literals.add(resolved.qualifiedName());
                    } else {
                        entry.literals.add(child.name);
                    }
                }

                result.set(symbol.qualifiedName(), entry);
            } else if (symbol instanceof BuiltInTokenSymbol) {
                result.set(symbol.qualifiedName(), {
                    kind: SymbolKind.BuiltInLexerToken,
                    rules: new Set<string>(),
                    tokens: new Set<string>(),
                    literals: new Set<string>(),
                });
            } else if (symbol instanceof VirtualTokenSymbol) {
                result.set(symbol.qualifiedName(), {
                    kind: SymbolKind.VirtualLexerToken,
                    rules: new Set<string>(),
                    tokens: new Set<string>(),
                    literals: new Set<string>(),
                });
            }
        }

        return result;
    }

    public getRRDScript(ruleName: string): string | undefined {
        this.runSemanticAnalysisIfNeeded();

        return this.rrdScripts.get(ruleName);
    }

    /**
     * Add this context to the list of referencing contexts in the given context.
     *
     * @param context The context to add.
     */
    public addAsReferenceTo(context: SourceContext): void {
        // Check for mutual inclusion. References are organized like a mesh.
        const pipeline: SourceContext[] = [context];
        while (pipeline.length > 0) {
            const current = pipeline.shift();
            if (!current) {
                continue;
            }

            if (current.references.indexOf(this) > -1) {
                return; // Already in the list.
            }

            pipeline.push(...current.references);
        }
        context.references.push(this);
        this.symbolTable.addDependencies(context.symbolTable);
    }

    /**
     * Remove the given context from our list of dependencies.
     *
     * @param context The context to remove.
     */
    public removeDependency(context: SourceContext): void {
        const index = context.references.indexOf(this);
        if (index > -1) {
            context.references.splice(index, 1);
        }
        this.symbolTable.removeDependency(context.symbolTable);
    }

    public getReferenceCount(symbol: string): number {
        this.runSemanticAnalysisIfNeeded();

        let result = this.symbolTable.getReferenceCount(symbol);

        for (const reference of this.references) {
            result += reference.getReferenceCount(symbol);
        }

        return result;
    }

    public async getAllSymbols(recursive: boolean): Promise<Symbol[]> {
        // The symbol table returns symbols of itself and those it depends on (if recursive is true).
        const result = await this.symbolTable.getAllSymbols(Symbol, !recursive);

        // Add also symbols from contexts referencing us, this time not recursive
        // as we have added our content already.
        for (const reference of this.references) {
            const symbols = await reference.symbolTable.getAllSymbols(Symbol, true);
            symbols.forEach((value) => {
                result.push(value);
            });
        }

        return result;
    }

    /**
     * Similar like `enclosingRangeForSymbol` but returns the rule's name and index, if found.
     *
     * @param column The position within a line.
     * @param row The line index.
     *
     * @returns A rule name and its index if found.
     */
    public ruleFromPosition(column: number, row: number): [string | undefined, number | undefined] {
        const tree = BackendUtils.parseTreeFromPosition(this.tree!, column, row);
        if (!tree) {
            return [undefined, undefined];
        }

        let context: RuleContext | undefined = (tree as RuleContext);
        while (context && context.ruleIndex !== ANTLRv4Parser.RULE_parserRuleSpec
            && context.ruleIndex !== ANTLRv4Parser.RULE_lexerRuleSpec) {
            context = context.parent;
        }

        if (context) {
            if (context.ruleIndex === ANTLRv4Parser.RULE_parserRuleSpec) {
                const ruleName = (context as ParserRuleSpecContext).RULE_REF().text;
                let ruleIndex;
                if (this.grammarParserData) {
                    ruleIndex = this.grammarParserRuleMap.get(ruleName);
                }

                return [ruleName, ruleIndex];
            }

            const name = (context as LexerRuleSpecContext).TOKEN_REF().text;
            let index;
            if (this.grammarLexerData) {
                index = this.grammarLexerRuleMap.get(name);
            }

            return [name, index];
        }

        return [undefined, undefined];
    }

    /**
     * Use ANTLR4 jars to generate target files for the grammar managed in this context and all its dependencies.
     *
     * @param dependencies A list of additional grammars which need generation too.
     * @param options Options to customize the generation process.
     *
     * @returns List of names of all participating files.
     */
    public async generate(dependencies: Set<SourceContext>, options: IGenerationOptions): Promise<string[]> {
        if (options.loadOnly) {
            this.setupInterpreters(options.outputDir);

            return Promise.resolve([]);
        }

        const javaRuntime = (options.alternativeJava) ? path.resolve(options.alternativeJava) : "java";

        const parameters = ["-jar"];
        if (options.alternativeJar) {
            parameters.push(options.alternativeJar);
        } else {
            if (options.language?.toLowerCase() === "typescript") {
                parameters.push(path.join(this.extensionDir, "antlr/antlr4-typescript-4.9.0-SNAPSHOT-complete.jar"));
            } else {
                parameters.push(path.join(this.extensionDir, "antlr/antlr-4.9.2-complete.jar"));
            }
        }

        if (options.language) {
            parameters.push("-Dlanguage=" + options.language);
        }

        parameters.push("-message-format");
        parameters.push("antlr");
        if (options.libDir) {
            parameters.push("-lib");
            parameters.push(options.libDir);
        }

        if (options.outputDir) {
            parameters.push("-o");
            parameters.push(options.outputDir);
        }

        if (options.package) {
            parameters.push("-package");
            parameters.push(options.package);
        }

        const genListener = options.listeners === undefined || options.listeners === true;
        parameters.push(genListener ? "-listener" : "-no-listener");
        parameters.push(options.visitors === true ? "-visitor" : "-no-visitor");
        parameters.push("-Xexact-output-dir"); // Available starting with 4.7.2.

        if (options.additionalParameters) {
            parameters.push(options.additionalParameters);
        }

        dependencies.add(this); // Needs this also in the error parser.

        let message = "";
        const fileList: string[] = [];
        const spawnOptions = { cwd: options.baseDir ? options.baseDir : undefined };

        const errorParser = new ErrorParser(dependencies);
        for await (const dependency of dependencies) {
            fileList.push(dependency.fileName);

            const actualParameters = [...parameters, dependency.fileName];
            const result = await this.doGeneration(javaRuntime, actualParameters, spawnOptions, errorParser, options.outputDir);
            if (result.length > 0) {
                message += "\n" + result;
            }
        }

        if (message.length > 0) {
            throw new Error(message);
        }

        return fileList;
    }

    public getATNGraph(rule: string): IAtnGraphData | undefined {
        const isLexerRule = rule[0] === rule[0].toUpperCase();
        if ((isLexerRule && !this.grammarLexerData) || (!isLexerRule && !this.grammarParserData)) {
            // Requires a generation run.
            return;
        }

        const ruleIndexMap = isLexerRule ? this.grammarLexerRuleMap : this.grammarParserRuleMap;
        if (!ruleIndexMap.has(rule)) {
            return;
        }
        const ruleIndex: number = ruleIndexMap.get(rule)!;

        const atn = isLexerRule ? this.grammarLexerData!.atn : this.grammarParserData!.atn;
        const ruleNames = isLexerRule ? this.grammarLexerData!.ruleNames : this.grammarParserData!.ruleNames;
        const vocabulary = isLexerRule ? this.grammarLexerData!.vocabulary : this.grammarParserData!.vocabulary;

        const startState = atn.ruleToStartState[ruleIndex];
        const stopState = atn.ruleToStopState[ruleIndex];

        const seenStates: Set<ATNState> = new Set([startState]);
        const pipeline: ATNState[] = [startState];

        const result: IAtnGraphData = {
            links: [],
            nodes: [],
        };

        // Maps an ATN state to its index in the rules list.
        const stateToIndex = new Map<number, number>();
        let currentRuleIndex = -1;

        /**
         * Checks the list of used ATN nodes for the given id and adds a new ATN node if no entry could be found.
         *
         * @param id The state identifier (usually the state number).
         * @param state The ATN state represented by the ATN node, if a new node must be added.
         *
         * @returns The index of the ATN node for the given state.
         */
        const ensureATNNode = (id: number, state: ATNState): number => {
            let index = stateToIndex.get(id);
            if (index === undefined) {
                const transitions = state.getTransitions();

                index = result.nodes.length;
                stateToIndex.set(id, index);
                result.nodes.push({
                    id,
                    name: id.toString(),
                    type: state.stateType,
                });

                // If this state transits to a new rule create also a fake node for that rule.
                if (transitions.length === 1 && transitions[0].target.stateType === ATNStateType.RULE_START) {
                    const marker = state.stateNumber * transitions[0].target.stateNumber;
                    stateToIndex.set(marker, result.nodes.length);

                    // Type 13 is a fake type denoting a rule. It's one beyond the highest ATNStateType values.
                    result.nodes.push({
                        id: currentRuleIndex--,
                        name: ruleNames[transitions[0].target.ruleIndex],
                        type: 13,
                    });
                }
            }

            return index;
        };

        while (pipeline.length > 0) {
            const state = pipeline.shift()!;

            const sourceIndex = ensureATNNode(state.stateNumber, state);
            for (const transition of state.getTransitions()) {
                // Rule stop states usually point to the follow state in the calling rule, but can also
                // point to a state in itself if the rule is left recursive. In any case we don't need to follow
                // transitions going out from a stop state.
                if (state === stopState) {
                    continue;
                }

                const transitsToRule = transition.target.stateType === ATNStateType.RULE_START;
                const marker = transition.target.stateNumber * (transitsToRule ? state.stateNumber : 1);
                const targetIndex = ensureATNNode(marker, transition.target);

                const link: IAtnLink = {
                    source: sourceIndex,
                    target: targetIndex,
                    type: transition.serializationType,
                    labels: [],
                };

                switch (transition.serializationType) {
                    case TransitionType.EPSILON: {
                        // Label added below.
                        break;
                    }

                    case TransitionType.RANGE: {
                        link.labels.push({ content: "Range Transition", class: "heading" });

                        break;
                    }

                    case TransitionType.RULE: {
                        link.labels.push({ content: "Rule Transition", class: "heading" });

                        break;
                    }

                    case TransitionType.PREDICATE: {
                        const predicateTransition = transition as PredicateTransition;
                        link.labels.push({
                            content: `Predicate Transition (${predicateTransition.predIndex})`,
                            class: "heading",
                        });

                        break;
                    }

                    case TransitionType.ATOM: {
                        link.labels.push({ content: "Atom Transition", class: "heading" });


                        break;
                    }

                    case TransitionType.ACTION: {
                        const actionTransition = transition as ActionTransition;
                        const index = actionTransition.actionIndex === 0xFFFF ? -1 : actionTransition.actionIndex;
                        if (isLexerRule) {
                            link.labels.push({ content: `Lexer Action (${index})`, class: "heading" });
                        } else {
                            // Parser actions are directly embedded. No idea why there are still action transitions
                            // in the parser ATN (always with -1 index).
                            link.labels.push({ content: "Parser Action", class: "heading" });
                        }

                        break;
                    }

                    case TransitionType.SET: {
                        link.labels.push({ content: "Set Transition", class: "heading" });
                        break;
                    }

                    case TransitionType.NOT_SET: {
                        link.labels.push({ content: "Not-Set Transition", class: "heading" });
                        break;
                    }

                    case TransitionType.WILDCARD: {
                        link.labels.push({ content: "Wildcard Transition", class: "heading" });
                        break;
                    }

                    case TransitionType.PRECEDENCE: {
                        const precedenceTransition = transition as PrecedencePredicateTransition;
                        link.labels.push({
                            content: `Precedence Predicate (${precedenceTransition.precedence})`,
                            class: "heading",
                        });
                        break;
                    }

                    default: {

                        break;
                    }
                }

                if (transition.isEpsilon) {
                    link.labels.push({ content: "ε" });
                } else if (transition.label) {
                    if (isLexerRule) {
                        this.intervalSetToStrings(transition.label).forEach((value) => {
                            link.labels.push({ content: value });
                        });
                    } else {
                        for (const label of transition.label.toArray()) {
                            link.labels.push({ content: vocabulary.getDisplayName(label) });
                        }
                    }
                } else {
                    link.labels.push({ content: "∀" });
                }

                result.links.push(link);

                let nextState: ATNState;
                if (transitsToRule) {
                    // Target is a state in a different rule (or this rule if left recursive).
                    // Add a back link from that sub rule into ours.
                    nextState = (transition as RuleTransition).followState;
                    const returnIndex = ensureATNNode(nextState.stateNumber, nextState);

                    const nodeLink: IAtnLink = {
                        source: targetIndex,
                        target: returnIndex,
                        type: TransitionType.RULE,
                        labels: [{ content: "ε" }],
                    };
                    result.links.push(nodeLink);
                } else {
                    nextState = transition.target;
                }

                if (seenStates.has(nextState)) {
                    continue;
                }

                seenStates.add(nextState);
                pipeline.push(nextState);
            }
        }

        return result;
    }

    /**
     * Generates strings that are valid input for the managed grammar.
     *
     * @param dependencies All source contexts on which this one depends (usually the lexer,
     *                     if this is a split grammar).
     * @param rule The rule to generate a sentence for.
     * @param options The settings controlling the generation.
     * @param callback A function to call for each generated sentence.
     */
    public generateSentence(dependencies: Set<SourceContext>, rule: string,
        options: ISentenceGenerationOptions, callback: (sentence: string, index: number) => void): void {
        if (!this.isInterpreterDataLoaded) {
            // Requires a generation run.
            callback("[No grammar data available]", 0);

            return;
        }

        if (rule.length === 0) {
            callback("[No rule specified]", 0);

            return;
        }

        const isLexerRule = rule[0] === rule[0].toUpperCase();
        let lexerData: IInterpreterData | undefined;
        let parserData: IInterpreterData | undefined;

        switch (this.info.type) {
            case GrammarType.Combined: {
                lexerData = this.grammarLexerData;
                parserData = this.grammarParserData;
                break;
            }

            case GrammarType.Lexer: {
                lexerData = this.grammarLexerData;
                break;
            }
            case GrammarType.Parser: {
                // Get lexer data from dependency.
                for (const dependency of dependencies) {
                    if (dependency.info.type === GrammarType.Lexer) {
                        lexerData = dependency.grammarLexerData;
                        break;
                    }
                }
                parserData = this.grammarParserData;
                break;
            }

            default: {
                break;
            }
        }

        if (!lexerData) { // Lexer data must always exist.
            callback("[No lexer data available]", 0);

            return;
        }

        if (!isLexerRule && !parserData) { // Parser data is only required for parser sentence generation.
            callback("[No parser data available]", 0);

            return;
        }

        let start: RuleStartState;
        if (isLexerRule) {
            const index = this.grammarLexerRuleMap.get(rule);
            if (index === undefined) {
                callback("[Virtual or undefined token]", 0);

                return;
            }
            start = lexerData.atn.ruleToStartState[index];
        } else {
            const index = this.grammarParserRuleMap.get(rule);
            if (index === undefined) {
                callback("[Undefined rule]", 0);

                return;
            }
            start = parserData!.atn.ruleToStartState[index];
        }

        try {
            const generator = new SentenceGenerator(this, lexerData, parserData, options.actionFile);

            const count = Math.max(options.count ?? 1, 1);
            for (let i = 0; i < count; ++i) {
                callback(generator.generate(options, start), i);
            }
        } catch (e) {
            callback(String(e), 0);
        }
    }

    /**
     * Testing support: take the input and run it through the lexer interpreter to see if it produces correct tokens.
     *
     * @param input The text to lex.
     * @param actionFile The name of a file that allows executing predicates/actions.
     *
     * @returns A tuple with recognized token names and an error message, if an error occurred.
     */
    public lexTestInput(input: string, actionFile?: string): [string[], string] {
        const result: string[] = [];
        let error = "";

        if (this.grammarLexerData) {
            let predicateFunction;
            if (actionFile) {
                const code = fs.readFileSync(actionFile, { encoding: "utf-8" }) + `
                const runPredicate = (predicate) => eval(predicate);
                runPredicate;
                `;

                predicateFunction = vm.runInNewContext(code) as PredicateFunction;
            }

            const stream = CharStreams.fromString(input);
            const lexer = new GrammarLexerInterpreter(predicateFunction, this, "<unnamed>",
                this.grammarLexerData, stream);
            lexer.removeErrorListeners();

            lexer.addErrorListener(
                new InterpreterLexerErrorListener((event: string | symbol, ...args: unknown[]): boolean => {
                    error += (args[0] as string) + "\n";

                    return true;
                }),
            );
            const tokenStream = new CommonTokenStream(lexer);
            tokenStream.fill();

            for (const token of tokenStream.getTokens()) {
                const name = lexer.vocabulary.getSymbolicName(token.type);
                result.push(name!);
            }
        }

        return [result, error];
    }

    /**
     * Testing support: take the input and run it through the parser interpreter to see if it is syntactically correct.
     *
     * @param input The text to parse.
     * @param startRule The rule to use for the parse run.
     * @param actionFile The name of a file that allows executing predicates/actions.
     *
     * @returns A list of errors if one occurred.
     */
    public parseTestInput(input: string, startRule: string, actionFile?: string): string[] {
        const errors: string[] = [];

        if (!this.grammarLexerData || !this.grammarParserData) {
            return ["No interpreter data available"];
        }

        let predicateFunction;
        if (actionFile) {
            const code = fs.readFileSync(actionFile, { encoding: "utf-8" }) + `
            const runPredicate = (predicate) => eval(predicate);
            runPredicate;
            `;

            predicateFunction = vm.runInNewContext(code) as PredicateFunction;
        }

        const eventSink = (event: string | symbol, ...args: unknown[]): void => {
            errors.push(args[0] as string);
        };

        const stream = CharStreams.fromString(input);
        const lexer = new GrammarLexerInterpreter(predicateFunction, this, "<unnamed>", this.grammarLexerData, stream);
        lexer.removeErrorListeners();

        lexer.addErrorListener(new InterpreterLexerErrorListener(eventSink));
        const tokenStream = new CommonTokenStream(lexer);
        tokenStream.fill();

        const parser = new GrammarParserInterpreter(eventSink, predicateFunction, this, this.grammarParserData,
            tokenStream);
        parser.buildParseTree = true;
        parser.removeErrorListeners();
        parser.addErrorListener(new InterpreterParserErrorListener(eventSink));

        const startRuleIndex = parser.getRuleIndex(startRule);
        parser.parse(startRuleIndex);

        return errors;
    }

    public getSymbolInfo(symbol: string | Symbol): ISymbolInfo | undefined {
        return this.symbolTable.getSymbolInfo(symbol);
    }

    public resolveSymbol(symbolName: string): Symbol | undefined {
        return this.symbolTable.resolveSync(symbolName, false);
    }

    public formatGrammar(options: IFormattingOptions, start: number, stop: number): [string, number, number] {
        this.tokenStream.fill();
        const tokens = this.tokenStream.getTokens();
        const formatter = new GrammarFormatter(tokens);

        return formatter.formatGrammar(options, start, stop);
    }

    /**
     * Loads interpreter data if it exists and sets up the interpreters.
     *
     * @param outputDir The path in which the output from the parser generation run, which contains the interpreter
     *                  data files.
     */
    public setupInterpreters(outputDir?: string): void {
        // Load interpreter data if the code generation was successful.
        // For that we only need the final parser and lexer files, not any imported stuff.
        // The target path is either the output path (if one was given) or the grammar path.
        let lexerFile = "";
        let parserFile = "";
        let baseName = (this.fileName.endsWith(".g4")
            ? path.basename(this.fileName, ".g4")
            : path.basename(this.fileName, ".g"));
        const grammarPath = (outputDir) ? outputDir : path.dirname(this.fileName);

        switch (this.info.type) {
            case GrammarType.Combined: {
                // In a combined grammar the lexer is implicitly extracted and treated as a separate file.
                // We have no own source context for this case and hence load both lexer and parser data here.
                parserFile = path.join(grammarPath, baseName) + ".interp";
                if (baseName.endsWith("Parser")) {
                    baseName = baseName.substring(0, baseName.length - "Parser".length);
                }
                lexerFile = path.join(grammarPath, baseName) + "Lexer.interp";
                break;
            }

            case GrammarType.Lexer: {
                lexerFile = path.join(grammarPath, baseName) + ".interp";
                break;
            }

            case GrammarType.Parser: {
                parserFile = path.join(grammarPath, baseName) + ".interp";
                break;
            }

            default: // Unknown, no data is loaded.
                break;
        }

        if (fs.existsSync(lexerFile)) {
            this.grammarLexerData = InterpreterDataReader.parseFile(lexerFile);
            const map = new Map<string, number>();
            for (let i = 0; i < this.grammarLexerData.ruleNames.length; ++i) {
                map.set(this.grammarLexerData.ruleNames[i], i);
            }
            this.grammarLexerRuleMap = map;
        } else {
            this.grammarLexerData = undefined;
            this.grammarLexerRuleMap.clear();
        }

        if (fs.existsSync(parserFile)) {
            this.grammarParserData = InterpreterDataReader.parseFile(parserFile);
            const map = new Map<string, number>();
            for (let i = 0; i < this.grammarParserData.ruleNames.length; ++i) {
                map.set(this.grammarParserData.ruleNames[i], i);
            }
            this.grammarParserRuleMap = map;
        } else {
            this.grammarParserData = undefined;
            this.grammarParserRuleMap.clear();
        }
    }

    /**
     * This method runs the generation for one file.
     *
     * @param javaRuntime The Java runtime binary to use.
     * @param parameters The command line parameters for ANTLR4.
     * @param spawnOptions The options for spawning Java.
     * @param errorParser The parser to use for ANTLR4 error messages.
     * @param outputDir The directory to find the interpreter data.
     *
     * @returns A string containing the error for non-grammar problems (process or java issues) otherwise empty.
     */
    private doGeneration(javaRuntime: string, parameters: string[], spawnOptions: object, errorParser: ErrorParser,
        outputDir?: string): Promise<string> {
        return new Promise((resolve, reject) => {
            const java = child_process.spawn(javaRuntime, parameters, spawnOptions);

            java.on("error", (error) => {
                resolve(`Error while running Java: "${error.message}". Is Java installed on you machine?`);
            });

            let buffer = "";
            java.stderr.on("data", (data: Buffer) => {
                let text = data.toString();
                if (text.startsWith("Picked up _JAVA_OPTIONS:")) {
                    const endOfInfo = text.indexOf("\n");
                    if (endOfInfo === -1) {
                        text = "";
                    } else {
                        text = text.substring(endOfInfo + 1);
                    }
                }

                if (text.length > 0) {
                    buffer += "\n" + text;
                }
            });

            java.on("close", (_code) => {
                errorParser.convertErrorsToDiagnostics(buffer).then((flag) => {
                    if (flag) {
                        this.setupInterpreters(outputDir);
                        resolve("");
                    } else {
                        reject(buffer); // Treat this as non-grammar output (e.g. Java exception).
                    }
                }).catch((reason) => {
                    reject(reason);
                });
            });
        });
    }

    private runSemanticAnalysisIfNeeded() {
        if (!this.semanticAnalysisDone) {
            this.semanticAnalysisDone = true;
            //this.diagnostics.length = 0; Don't, we would lose our syntax errors from last parse run.
            this.rrdScripts = new Map<string, string>();
            const semanticListener = new SemanticListener(this.diagnostics, this.symbolTable);
            ParseTreeWalker.DEFAULT.walk(semanticListener, this.tree!);

            const visitor = new RuleVisitor(this.rrdScripts);
            visitor.visit(this.tree!);
        }
    }

    /**
     * Convert an interval set to a list of ranges, consumable by a human.
     *
     * @param set The set to convert.
     * @returns A list of strings, one for each defined interval.
     */
    private intervalSetToStrings(set: IntervalSet): string[] {
        const result: string[] = [];

        /**
         * Return a readable representation of a code point. The input can be anything from the
         * full Unicode range.
         *
         * @param char The code point to convert.
         *
         * @returns The string representation of the character.
         */
        const characterRepresentation = (char: number): string => {
            if (char < 0) {
                return "EOF";
            }

            if (SourceContext.printableChars.contains(char)) {
                return "'" + String.fromCharCode(char) + "'";
            }

            const value = char.toString(16).toUpperCase();

            return "\\u" + "0".repeat(4 - value.length) + value;
        };

        for (const interval of set.intervals) {
            let entry = characterRepresentation(interval.a);
            if (interval.a !== interval.b) {
                entry += " - " + characterRepresentation(interval.b);
            }
            result.push(entry);
        }

        return result;
    }
}
