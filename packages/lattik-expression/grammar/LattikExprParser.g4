/**
 * Lattik Expression Language — Parser Grammar
 *
 * Parses a single SQL-like expression (not a full SELECT statement).
 * Supports scalar expressions, aggregations, and window functions.
 *
 * Operator precedence is encoded via ANTLR4's left-recursive alternative
 * ordering: alternatives listed first bind tighter.
 */
parser grammar LattikExprParser;

options { tokenVocab = LattikExprLexer; }

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/** A complete expression (the only entry point). */
root
    : expr EOF
    ;

// ---------------------------------------------------------------------------
// Expression (precedence from highest to lowest by alternative order)
// ---------------------------------------------------------------------------

expr
    : LPAREN expr RPAREN                                      # parenExpr
    | MINUS expr                                              # unaryMinusExpr
    | NOT expr                                                # notExpr
    | expr op=( STAR | SLASH | PERCENT ) expr                 # mulDivModExpr
    | expr op=( PLUS | MINUS | PIPE_PIPE ) expr               # addSubConcatExpr
    | expr comparisonOp expr                                  # comparisonExpr
    | expr IS NOT? NULL                                       # isNullExpr
    | expr NOT? BETWEEN expr AND expr                         # betweenExpr
    | expr NOT? IN LPAREN exprList RPAREN                     # inExpr
    | expr NOT? LIKE expr                                     # likeExpr
    | expr AND expr                                           # andExpr
    | expr OR expr                                            # orExpr
    | caseExpr                                                # caseExprAlt
    | castExpr                                                # castExprAlt
    | functionCall                                            # functionCallAlt
    | columnRef                                               # columnRefAlt
    | star                                                    # starAlt
    | literal                                                 # literalAlt
    ;

// ---------------------------------------------------------------------------
// Comparison operators
// ---------------------------------------------------------------------------

comparisonOp
    : EQ | NEQ | LTGT | LT | LTE | GT | GTE
    ;

// ---------------------------------------------------------------------------
// Literals
// ---------------------------------------------------------------------------

literal
    : INTEGER_LITERAL                                         # intLiteral
    | DECIMAL_LITERAL                                         # decimalLiteral
    | STRING_LITERAL                                          # stringLiteral
    | TRUE                                                    # trueLiteral
    | FALSE                                                   # falseLiteral
    | NULL                                                    # nullLiteral
    ;

// ---------------------------------------------------------------------------
// References
// ---------------------------------------------------------------------------

columnRef
    : ( IDENTIFIER DOT )? IDENTIFIER
    ;

star
    : ( IDENTIFIER DOT )? STAR
    ;

// ---------------------------------------------------------------------------
// CASE
// ---------------------------------------------------------------------------

caseExpr
    : CASE expr? whenClause+ ( ELSE expr )? END
    ;

whenClause
    : WHEN expr THEN expr
    ;

// ---------------------------------------------------------------------------
// CAST
// ---------------------------------------------------------------------------

castExpr
    : CAST LPAREN expr AS dataType RPAREN
    ;

dataType
    : STRING_TYPE
    | INT32_TYPE
    | INT64_TYPE
    | FLOAT_TYPE
    | DOUBLE_TYPE
    | BOOLEAN_TYPE
    | TIMESTAMP_TYPE
    | DATE_TYPE
    | JSON_TYPE
    ;

// ---------------------------------------------------------------------------
// Function calls and aggregates
// ---------------------------------------------------------------------------

/**
 * Aggregates vs scalar functions are distinguished semantically
 * (by name), not syntactically — both use the same production.
 */
functionCall
    : IDENTIFIER LPAREN DISTINCT? exprList? RPAREN filterClause? windowClause?
    | IDENTIFIER LPAREN STAR RPAREN filterClause? windowClause?       // COUNT(*)
    ;

filterClause
    : FILTER LPAREN WHERE expr RPAREN
    ;

// ---------------------------------------------------------------------------
// Window
// ---------------------------------------------------------------------------

windowClause
    : OVER LPAREN partitionClause? orderClause? frameClause? RPAREN
    ;

partitionClause
    : PARTITION BY exprList
    ;

orderClause
    : ORDER BY orderItem ( COMMA orderItem )*
    ;

orderItem
    : expr ( ASC | DESC )? ( NULLS ( FIRST | LAST ) )?
    ;

frameClause
    : ( ROWS | RANGE ) frameBound ( AND frameBound )?
    ;

frameBound
    : UNBOUNDED PRECEDING                                     # unboundedPreceding
    | UNBOUNDED FOLLOWING                                     # unboundedFollowing
    | CURRENT ROW                                             # currentRow
    | expr PRECEDING                                          # offsetPreceding
    | expr FOLLOWING                                          # offsetFollowing
    ;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

exprList
    : expr ( COMMA expr )*
    ;
