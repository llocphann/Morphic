import { tokenizeExpression } from "./lexer";
import { LexemeKind, type ExpressionNode, type Lexeme } from "./model";

const PRECEDENCE: Record<string, number> = {
	"||": 1,
	"&&": 2,
	"==": 3,
	"!=": 3,
	"<": 4,
	">": 4,
	"<=": 4,
	">=": 4,
	"+": 5,
	"-": 5,
	"*": 6,
	"/": 6,
	"%": 6,
	"**": 7,
};

export function parseExpressionSource(source: string): ExpressionNode {
	const parser = new PrattParser(tokenizeExpression(source));
	return parser.parse();
}

class PrattParser {
	private cursor = 0;

	constructor(private readonly tokens: readonly Lexeme[]) {}

	parse(): ExpressionNode {
		const expression = this.parseBinary(0);
		if (this.peek().type !== LexemeKind.EOF) {
			throw this.error(`Unexpected token ${JSON.stringify(this.peek().value)}`);
		}
		return expression;
	}

	private parseBinary(minimumPrecedence: number): ExpressionNode {
		let left = this.parsePrefix();
		while (this.peek().type === LexemeKind.Operator) {
			const operator = this.peek().value;
			const precedence = PRECEDENCE[operator];
			if (precedence === undefined || precedence < minimumPrecedence) break;
			this.advance();
			const right = this.parseBinary(precedence + 1);
			left = { type: "binaryOp", op: operator, left, right };
		}
		return left;
	}

	private parsePrefix(): ExpressionNode {
		const token = this.peek();
		if (token.type === LexemeKind.Operator && (token.value === "!" || token.value === "-")) {
			this.advance();
			return { type: "unaryOp", op: token.value, operand: this.parsePrefix() };
		}
		return this.parsePostfix(this.parsePrimary());
	}

	private parsePostfix(initial: ExpressionNode): ExpressionNode {
		let node = initial;
		while (true) {
			if (this.accept(LexemeKind.Dot)) {
				const name = this.expect(LexemeKind.Identifier).value;
				if (this.accept(LexemeKind.LeftParen)) {
					node = { type: "methodCall", object: node, method: name, args: this.parseArguments() };
				} else {
					node = { type: "propertyAccess", object: node, property: name };
				}
				continue;
			}
			if (this.accept(LexemeKind.LeftBracket)) {
				const index = this.parseBinary(0);
				this.expect(LexemeKind.RightBracket);
				node = { type: "arrayAccess", object: node, index };
				continue;
			}
			break;
		}
		return node;
	}

	private parsePrimary(): ExpressionNode {
		const token = this.advance();
		switch (token.type) {
			case LexemeKind.Number:
				return { type: "number", value: Number.parseFloat(token.value) };
			case LexemeKind.String:
				return { type: "string", value: token.value };
			case LexemeKind.Regex:
				return { type: "regex", pattern: token.value, flags: token.flags ?? "" };
			case LexemeKind.Identifier:
				return this.identifierNode(token);
			case LexemeKind.LeftParen: {
				const nested = this.parseBinary(0);
				this.expect(LexemeKind.RightParen);
				return nested;
			}
			case LexemeKind.LeftBracket:
				return { type: "arrayLiteral", elements: this.parseArrayElements() };
			default:
				throw this.error(`Unexpected token ${JSON.stringify(token.value)}`, token);
		}
	}

	private identifierNode(token: Lexeme): ExpressionNode {
		if (token.value === "true" || token.value === "false") {
			return { type: "boolean", value: token.value === "true" };
		}
		if (token.value === "null") return { type: "null" };
		if (!this.accept(LexemeKind.LeftParen)) return { type: "identifier", name: token.value };
		return { type: "functionCall", name: token.value, args: this.parseArguments() };
	}

	private parseArguments(): ExpressionNode[] {
		const args: ExpressionNode[] = [];
		if (this.accept(LexemeKind.RightParen)) return args;
		do {
			args.push(this.parseBinary(0));
		} while (this.accept(LexemeKind.Comma));
		this.expect(LexemeKind.RightParen);
		return args;
	}

	private parseArrayElements(): ExpressionNode[] {
		const elements: ExpressionNode[] = [];
		if (this.accept(LexemeKind.RightBracket)) return elements;
		do {
			elements.push(this.parseBinary(0));
		} while (this.accept(LexemeKind.Comma));
		this.expect(LexemeKind.RightBracket);
		return elements;
	}

	private accept(kind: LexemeKind): boolean {
		if (this.peek().type !== kind) return false;
		this.cursor++;
		return true;
	}

	private expect(kind: LexemeKind): Lexeme {
		const token = this.peek();
		if (token.type !== kind) throw this.error(`Expected ${LexemeKind[kind]}`, token);
		this.cursor++;
		return token;
	}

	private peek(): Lexeme {
		return this.tokens[this.cursor] ?? this.tokens[this.tokens.length - 1];
	}

	private advance(): Lexeme {
		const token = this.peek();
		this.cursor++;
		return token;
	}

	private error(message: string, token: Lexeme = this.peek()): Error {
		return new Error(`${message} at position ${token.pos}`);
	}
}
