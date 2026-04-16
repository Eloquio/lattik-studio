/**
 * Lattik Expression Language — Lexer Grammar
 *
 * SQL-like expression syntax for computed fields, aggregations,
 * and window functions in Lattik pipelines.
 *
 * Case-insensitive keywords via fragment letters.
 */
lexer grammar LattikExprLexer;

// ---------------------------------------------------------------------------
// Keywords
// ---------------------------------------------------------------------------

AND       : A N D ;
OR        : O R ;
NOT       : N O T ;
IS        : I S ;
NULL      : N U L L ;
TRUE      : T R U E ;
FALSE     : F A L S E ;
IN        : I N ;
BETWEEN   : B E T W E E N ;
LIKE      : L I K E ;
CASE      : C A S E ;
WHEN      : W H E N ;
THEN      : T H E N ;
ELSE      : E L S E ;
END       : E N D ;
CAST      : C A S T ;
AS        : A S ;
OVER      : O V E R ;
PARTITION : P A R T I T I O N ;
BY        : B Y ;
ORDER     : O R D E R ;
ASC       : A S C ;
DESC      : D E S C ;
ROWS      : R O W S ;
RANGE     : R A N G E ;
UNBOUNDED : U N B O U N D E D ;
PRECEDING : P R E C E D I N G ;
FOLLOWING : F O L L O W I N G ;
CURRENT   : C U R R E N T ;
ROW       : R O W ;
FILTER    : F I L T E R ;
WHERE     : W H E R E ;
DISTINCT  : D I S T I N C T ;
NULLS     : N U L L S ;
FIRST     : F I R S T ;
LAST      : L A S T ;

// ---------------------------------------------------------------------------
// Type keywords (used in CAST ... AS <type>)
// ---------------------------------------------------------------------------

STRING_TYPE    : S T R I N G ;
INT32_TYPE     : I N T '32' ;
INT64_TYPE     : I N T '64' ;
FLOAT_TYPE     : F L O A T ;
DOUBLE_TYPE    : D O U B L E ;
BOOLEAN_TYPE   : B O O L E A N ;
TIMESTAMP_TYPE : T I M E S T A M P ;
DATE_TYPE      : D A T E ;
JSON_TYPE      : J S O N ;

// ---------------------------------------------------------------------------
// Operators
// ---------------------------------------------------------------------------

PLUS      : '+' ;
MINUS     : '-' ;
STAR      : '*' ;
SLASH     : '/' ;
PERCENT   : '%' ;
PIPE_PIPE : '||' ;
EQ        : '=' ;
NEQ       : '!=' ;
LTGT      : '<>' ;
LTE       : '<=' ;
GTE       : '>=' ;
LT        : '<' ;
GT        : '>' ;

// ---------------------------------------------------------------------------
// Delimiters
// ---------------------------------------------------------------------------

LPAREN : '(' ;
RPAREN : ')' ;
COMMA  : ',' ;
DOT    : '.' ;

// ---------------------------------------------------------------------------
// Literals
// ---------------------------------------------------------------------------

DECIMAL_LITERAL : DIGIT+ '.' DIGIT+ ;
INTEGER_LITERAL : DIGIT+ ;
STRING_LITERAL  : '\'' ( '\'\'' | ~'\'' )* '\'' ;

// ---------------------------------------------------------------------------
// Identifiers
// ---------------------------------------------------------------------------

QUOTED_IDENTIFIER : '"' ( ~'"' )* '"' ;
IDENTIFIER        : LETTER ( LETTER | DIGIT )* ;

// ---------------------------------------------------------------------------
// Whitespace & comments
// ---------------------------------------------------------------------------

WS          : [ \t\r\n]+ -> skip ;
LINE_COMMENT: '--' ~[\r\n]* -> skip ;

// ---------------------------------------------------------------------------
// Fragments (case-insensitive letter matching)
// ---------------------------------------------------------------------------

fragment DIGIT  : [0-9] ;
fragment LETTER : [a-zA-Z_] ;

fragment A : [aA] ;
fragment B : [bB] ;
fragment C : [cC] ;
fragment D : [dD] ;
fragment E : [eE] ;
fragment F : [fF] ;
fragment G : [gG] ;
fragment H : [hH] ;
fragment I : [iI] ;
fragment J : [jJ] ;
fragment K : [kK] ;
fragment L : [lL] ;
fragment M : [mM] ;
fragment N : [nN] ;
fragment O : [oO] ;
fragment P : [pP] ;
fragment Q : [qQ] ;
fragment R : [rR] ;
fragment S : [sS] ;
fragment T : [tT] ;
fragment U : [uU] ;
fragment V : [vV] ;
fragment W : [wW] ;
fragment X : [xX] ;
fragment Y : [yY] ;
fragment Z : [zZ] ;
