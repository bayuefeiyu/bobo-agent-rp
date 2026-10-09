/**
 * Host declaration shim for the Pi RP web extension.
 *
 * `.agents/skills/st-card-to-pi-rp/assets/pi-rp-runtime/.pi/extensions/pi-rp-web.ts`
 * imports exactly two packages that are not installed in this repository:
 *
 *   import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
 *   import { Type } from "typebox";
 *
 * This file declares only the surface that the extension actually touches, so that a wrong
 * call site becomes a type error instead of silently passing.
 *
 * Sources used (both on this machine, not vendored into the repository):
 *   [pi]     %APPDATA%\npm\node_modules\@earendil-works\pi-coding-agent
 *              dist\core\extensions\types.d.ts   (source: src/core/extensions/types.ts)
 *              dist\core\model-registry.d.ts, dist\core\session-manager.d.ts
 *              node_modules\@earendil-works\pi-ai\dist\types.d.ts
 *              node_modules\@earendil-works\pi-agent-core\dist\types.d.ts
 *   [typebox] ...\pi-coding-agent\node_modules\typebox\build\...   (typebox 1.3.27)
 *
 * Every declared member carries a comment stating whether its signature was taken from Pi's
 * real d.ts (with the citation) or inferred from call sites in pi-rp-web.ts.
 */

/* ------------------------------------------------------------------------------------------------
 * typebox 1.3.27 — the `Type` namespace, reduced to the members pi-rp-web.ts uses.
 *
 * Used members (counts from pi-rp-web.ts): String x20, Literal x18, Optional x17, Object x15,
 * Integer x8, Union x6, Record x3, Array x3, Any x3, Unsafe x3.
 * Real signatures come from build/type/types/{object,string,integer,array,union,literal,record,
 * any,unsafe,_optional,schema,properties}.d.mts plus build/typebox.d.mts (the namespace barrel).
 * The `Static<T>` machinery is a faithful reduction of build/type/types/static.mts +
 * properties.d.mts: the required/optional modifier protocol is preserved (`parameters.card` must be
 * `string`, not `string | undefined`), and so is the object/array/union/literal/record key
 * reduction, so a schema literal such as `Type.Literal("story-browser")` still yields the literal
 * string type and `Type.Record(Type.String(), Type.Any())` still yields `Record<string, any>`.
 *
 * One deliberate, documented deviation from build/type/types/union.d.mts: `StaticUnion` there
 * recurses over a *tuple* (`Types extends [infer Left, ...infer Right]`), so the dynamic-array form
 * `Type.Union(ids.map((id: string) => Type.Literal(id)))` used by pi-rp-web.ts reduces to `never`.
 * The mapped-type reduction used here accepts a plain array as well and yields `string`, which is
 * the more useful answer and never *hides* an error the tuple form would have caught.
 * ---------------------------------------------------------------------------------------------- */
declare module "typebox" {
	/** [typebox] build/type/types/schema.d.mts — `interface TSchema {}` (empty base). */
	interface TSchema {}

	/**
	 * [typebox] build/type/types/schema.d.mts — base JSON-Schema keyword bag. The real interface
	 * has an `[key: PropertyKey]: unknown` index signature, which is load-bearing: it is what lets
	 * `{ minItems: 1 }`, `{ pattern: "..." }`, `{ additionalProperties: false }` and the
	 * `~optional` marker pass through the options objects used in pi-rp-web.ts.
	 */
	interface TSchemaOptions {
		[key: PropertyKey]: unknown;
		$schema?: string;
		$id?: string;
		title?: string;
		description?: string;
		default?: unknown;
		examples?: unknown;
		readOnly?: boolean;
		writeOnly?: boolean;
		if?: TSchema;
		then?: TSchema;
		else?: TSchema;
	}

	/** [typebox] build/type/types/schema.d.mts — TObjectOptions (used by Object/Record). */
	interface TObjectOptions extends TSchemaOptions {
		additionalProperties?: TSchema | boolean;
		minProperties?: number;
		maxProperties?: number;
		dependencies?: Record<string, boolean | TSchema | string[]>;
		dependentRequired?: Record<string, string[]>;
		dependentSchemas?: Record<string, TSchema>;
		patternProperties?: Record<string, TSchema>;
		propertyNames?: TSchema;
	}

	/** [typebox] build/type/types/schema.d.mts — TArrayOptions (used by Array). */
	interface TArrayOptions extends TSchemaOptions {
		minItems?: number;
		maxItems?: number;
		contains?: TSchema;
		minContains?: number;
		maxContains?: number;
		prefixItems?: TSchema[];
		uniqueItems?: boolean;
	}

	/** [typebox] build/type/types/schema.d.mts — TNumberOptions (used by Integer). */
	interface TNumberOptions extends TSchemaOptions {
		exclusiveMaximum?: number | bigint;
		exclusiveMinimum?: number | bigint;
		maximum?: number | bigint;
		minimum?: number | bigint;
		multipleOf?: number | bigint;
	}

	/** [typebox] build/type/types/schema.d.mts — TStringOptions (used by String). */
	interface TStringOptions extends TSchemaOptions {
		format?: TFormat;
		minLength?: number;
		maxLength?: number;
		pattern?: string | RegExp;
	}

	/** [typebox] build/type/types/schema.d.mts — TFormat. */
	type TFormat =
		| "date-time" | "date" | "duration" | "email" | "hostname" | "idn-email" | "idn-hostname"
		| "ipv4" | "ipv6" | "iri-reference" | "iri" | "json-pointer-uri-fragment" | "json-pointer"
		| "json-string" | "regex" | "relative-json-pointer" | "time" | "uri-reference"
		| "uri-template" | "uri" | "url" | "uuid"
		| ({} & string);

	/**
	 * [typebox] build/type/types/schema.d.mts — `TObjectOptions` carries the `additionalProperties`
	 * keyword; modelled above so `Type.Object(props, { additionalProperties: false })` type-checks.
	 */

	/**
	 * [typebox] build/type/types/properties.d.mts — `interface TProperties extends TSchema`.
	 * Real file: `[key: PropertyKey]: TSchema`.
	 */
	interface TProperties extends TSchema {
		[key: PropertyKey]: TSchema;
	}

	/**
	 * [typebox] build/type/types/properties.d.mts — `TRequiredArray<Properties>` reduced to the
	 * observable behaviour: the string keys of `Properties` whose value is not `TOptional`.
	 * The real type resolves through `TUnionToTuple`; the tuple-vs-array distinction is
	 * unobservable at every call site in pi-rp-web.ts.
	 */
	type TRequiredArray<Properties extends TProperties> = Extract<
		{ [Key in keyof Properties]: Properties[Key] extends TOptional ? never : Key }[keyof Properties],
		string
	>;

	/**
	 * [typebox] build/type/types/_optional.d.mts — `Optional<Type>` / `TOptional<Type>` /
	 * `TAddOptional`. Taken from the real file; the intersection form is exactly how the real
	 * `TAddOptional` marks a schema, which is what `Static` reads back to decide optionality.
	 */
	type TAddOptional<Type extends TSchema> = Type & { "~optional": true };
	type TOptional<Type extends TSchema = TSchema> = Type & { "~optional": true };

	/** [typebox] build/type/types/object.d.mts — `TObject<Properties>`. */
	interface TObject<Properties extends TProperties = TProperties> extends TSchema {
		"~kind": "Object";
		type: "object";
		properties: Properties;
		required: TRequiredArray<Properties>;
	}

	/** [typebox] build/type/types/string.d.mts — `TString`. */
	interface TString extends TSchema {
		"~kind": "String";
		type: "string";
	}

	/** [typebox] build/type/types/integer.d.mts — `TInteger`. */
	interface TInteger extends TSchema {
		"~kind": "Integer";
		type: "integer";
	}

	/** [typebox] build/type/types/array.d.mts — `TArray<Type>`. */
	interface TArray<Item extends TSchema = TSchema> extends TSchema {
		"~kind": "Array";
		type: "array";
		items: Item;
	}

	/** [typebox] build/type/types/union.d.mts — `TUnion<Types>`. */
	interface TUnion<Types extends TSchema[] = TSchema[]> extends TSchema {
		"~kind": "Union";
		anyOf: Types;
	}

	/** [typebox] build/type/types/literal.d.mts — `TLiteralValue` / `TLiteral<Value>`. */
	type TLiteralValue = string | number | boolean | bigint;
	interface TLiteral<Value extends TLiteralValue = TLiteralValue> extends TSchema {
		"~kind": "Literal";
		const: Value;
	}

	/**
	 * [typebox] build/type/types/record.d.mts — `TRecord<Key, Value>`, where `Key` is the
	 * *pattern string* the key schema reduces to (`StringKey` = "^.*$", `IntegerKey`,
	 * `NumberKey`) or a literal property name.
	 */
	interface TRecord<Key extends string = string, Value extends TSchema = TSchema> extends TSchema {
		"~kind": "Record";
		type: "object";
		patternProperties: { [_ in Key]: Value };
	}

	/**
	 * [typebox] build/type/types/record.d.mts — `StringKey` / `IntegerKey` / `NumberKey`, plus
	 * `TRecordPattern` / `StaticPropertyKey` from the same file.
	 *
	 * These are load-bearing for `Static`: `TRecord` prints its key back into `patternProperties`,
	 * and the *kind* of that pattern decides whether the static key is `string` or `number`.
	 * Reading the key back out of `patternProperties` (rather than inferring it from a
	 * `TRecord<infer Key, ...>` position, which TypeScript cannot do through a mapped type) is how
	 * the real `TRecordPattern` does it — and keeping the value inference in an
	 * `infer Value extends TSchema` position is what keeps `Static<any>` terminating.
	 */
	type TRecordStringKey = "^.*$";
	type TRecordIntegerKey = "^-?(?:0|[1-9][0-9]*)$";
	type TRecordNumberKey = "^-?(?:0|[1-9][0-9]*)(?:\\.[0-9]+)?$";
	type TRecordPattern<
		Type extends TRecord,
		Result extends string = Extract<keyof Type["patternProperties"], string>,
	> = Result;
	type TStaticPropertyKey<
		Key extends string,
		Result extends PropertyKey = Key extends TRecordStringKey
			? string
			: Key extends TRecordIntegerKey
				? number
				: Key extends TRecordNumberKey
					? number
					: string,
	> = Result;

	/**
	 * [typebox] build/type/engine/record/from_key_literal.d.mts — `TFromLiteralKey`. A *literal*
	 * record key does not produce a `TRecord` at all: real typebox turns it into a single-property
	 * `TObject`, which is why `Static<Type.Record(Type.Literal("a"), Type.String())>` is
	 * `{ a: string }` and not `Record<string, string>`.
	 */
	type TRecordLiteralKey<
		Value extends TLiteralValue,
		Result extends PropertyKey = Value extends string | number
			? Value
			: Value extends false
				? "false"
				: Value extends true
					? "true"
					: never,
	> = Result;

	/** [typebox] build/type/types/any.d.mts — `TAny`. */
	interface TAny extends TSchema {
		"~kind": "Any";
	}

	/** [typebox] build/type/types/unsafe.d.mts — `TUnsafe<Type>`. */
	interface TUnsafe<Type extends unknown = unknown> extends TSchema {
		"~unsafe": Type;
	}

	/**
	 * [typebox] build/type/types/static.mts + properties.d.mts — faithful reduction of `Static<T>`.
	 * The real implementation threads four type parameters (Stack/Direction/Context/This) for
	 * recursive schemas; none of that is observable here. Required/optional resolution follows the
	 * real `StaticPropertiesWithModifiers` + `TRequiredArray` protocol, including the real
	 * `TOptional<Properties[Key]>` self-referential optionality test and the real
	 * `keyof Properties extends never ? object` case for an empty property bag.
	 */
	type StaticObject<
		Properties extends TProperties,
		RequiredKeys extends keyof Properties = keyof Properties extends never
			? never
			: Exclude<
					{ [Key in keyof Properties]: Properties[Key] extends TOptional<Properties[Key]> ? never : Key }[keyof Properties],
					never
				>,
		RequiredShape = { [Key in RequiredKeys]: Static<Properties[Key]> },
		OptionalKeys = Exclude<keyof Properties, RequiredKeys>,
		OptionalShape = { [Key in OptionalKeys]?: Static<Properties[Key]> },
	> = keyof Properties extends never ? object : RequiredShape & OptionalShape;

	type Static<T extends TSchema> = T extends TObject<infer Properties extends TProperties>
		? StaticObject<Properties>
		: T extends TArray<infer Item extends TSchema>
			? Static<Item>[]
			: T extends TUnion<infer Types extends TSchema[]>
				? { [Index in keyof Types]: Static<Types[Index]> }[number]
				: T extends TLiteral<infer Value extends TLiteralValue>
					? Value
					: T extends TString
						? string
						: T extends TInteger
							? number
							: T extends TAny
								? any
								: T extends TUnsafe<infer Unsafe>
									? Unsafe
									: T extends TRecord<string, infer Value extends TSchema>
										? Record<TStaticPropertyKey<TRecordPattern<T>>, Static<Value>>
										: unknown;

	/**
	 * [typebox] build/typebox.d.mts — the `Type` namespace barrel. Declared as an object shape
	 * (rather than `declare namespace Type`) so that both `import { Type } from "typebox"` and the
	 * generic `Type` *type* namespace name stay available, which is how the real d.ts exports it.
	 */
	interface TypeNamespace {
		/** [typebox] build/type/types/object.d.mts — `_Object_<Properties>(properties, options?)`. */
		Object<Properties extends TProperties>(
			properties: Properties,
			options?: TObjectOptions,
		): TObject<Properties>;

		/** [typebox] build/type/types/string.d.mts — `String(options?)`. */
		String(options?: TStringOptions): TString;

		/** [typebox] build/type/types/integer.d.mts — `Integer(options?)`. */
		Integer(options?: TNumberOptions): TInteger;

		/** [typebox] build/type/types/array.d.mts — `_Array_<Type>(items, options?)`. */
		Array<Item extends TSchema>(items: Item, options?: TArrayOptions): TArray<Item>;

		/** [typebox] build/type/types/union.d.mts — `Union<Types>(anyOf, options?)`. */
		Union<Types extends TSchema[]>(anyOf: [...Types], options?: TSchemaOptions): TUnion<Types>;

		/** [typebox] build/type/types/literal.d.mts — `Literal<Value>(value, options?)`. */
		Literal<Value extends TLiteralValue>(value: Value, options?: TSchemaOptions): TLiteral<Value>;

		/**
		 * [typebox] build/type/types/record.d.mts — `Record<Key, Value>(key, value, options?)`.
		 * The real generic constraint is `Key extends TSchema` (the *schema* is the key), which
		 * is why the schema type is passed in; a `Key extends string` constraint here would reject
		 * the correct `Type.Record(Type.String(), Type.Any())` call in pi-rp-web.ts.
		 *
		 * The return type is the reduction of the real `TRecordAction` → `TFromKey` dispatch
		 * (build/type/engine/record/from_key*.d.mts): the key schema decides the *shape* of the
		 * result, so a `Type.Literal("a")` key must not degrade to a string-keyed record. Only the
		 * key schemas this shim declares are dispatched on — `TAny`, `TString`, `TInteger` and
		 * `TLiteral` — because `Number()`/`Boolean()`/`Enum()`/`Intersect()`/template-literal keys
		 * cannot be produced through the reduced `Type` surface below. Every other key reduces, as
		 * the real `TFromKey` fallback does, to the empty object `TObject<{}>`.
		 */
		Record<Key extends TSchema, Value extends TSchema>(
			key: Key,
			value: Value,
			options?: TObjectOptions,
		): Key extends TAny
			? TRecord<TRecordStringKey, Value>
			: Key extends TString
				? TRecord<TRecordStringKey, Value>
				: Key extends TInteger
					? TRecord<TRecordIntegerKey, Value>
					: Key extends TLiteral<infer LiteralKey extends TLiteralValue>
						? TObject<{ [_ in TRecordLiteralKey<LiteralKey>]: Value }>
						: TObject<{}>;

		/** [typebox] build/type/types/any.d.mts — `Any(options?)`. */
		Any(options?: TSchemaOptions): TAny;

		/**
		 * [typebox] build/type/types/unsafe.d.mts — `Unsafe<Type>(schema)`.
		 * pi-rp-web.ts calls it as `Type.Unsafe(schema)` where `schema: any`, so `Type` infers as
		 * `unknown`; the real declaration is `<Type extends unknown>(schema: TSchema)`, i.e. this
		 * parameter is genuinely untyped input, not a mistake in the call site.
		 */
		Unsafe<Type extends unknown = unknown>(schema: TSchema): TUnsafe<Type>;

		/** [typebox] build/type/types/_optional.d.mts — `Optional<Type>(type)`. */
		Optional<Type extends TSchema>(type: Type): TAddOptional<Type>;
	}

	/** [typebox] build/index.d.mts — `export * as Type from './typebox.mjs'`. */
	const Type: TypeNamespace;
}

/* ------------------------------------------------------------------------------------------------
 * @earendil-works/pi-coding-agent — only the ExtensionAPI / ExtensionContext surface the
 * extension touches, plus the structural types those members expose.
 * ---------------------------------------------------------------------------------------------- */
declare module "@earendil-works/pi-coding-agent" {
	/**
	 * [pi] dist/core/extensions/types.d.ts L242/L256 (via node_modules/@earendil-works/pi-ai/
	 * dist/types.d.ts) — the content blocks returned from `registerTool(...).execute`.
	 */
	interface TextContent {
		type: "text";
		text: string;
	}
	interface ImageContent {
		type: "image";
		data: string;
		mimeType: string;
	}

	/**
	 * [pi] node_modules/@earendil-works/pi-agent-core/dist/types.d.ts L337 — `AgentToolResult<T>`.
	 *
	 * DEVIATION, deliberately loose: the real d.ts declares `details: T` as *required*. The
	 * registered tool `start_rp_web` in pi-rp-web.ts returns `{ content: [...] }` with no
	 * `details`, which is accepted by the real runtime but rejected by the real type. Declaring
	 * `details?: T` keeps that existing call site compiling; see the report for this finding.
	 */
	interface AgentToolResult<TDetails = unknown> {
		content: (TextContent | ImageContent)[];
		details?: TDetails;
		usage?: unknown;
		terminate?: boolean;
	}

	/** [pi] node_modules/@earendil-works/pi-agent-core/dist/types.d.ts L356 — `AgentToolUpdateCallback<T>`. */
	type AgentToolUpdateCallback<TDetails = unknown> = (partialResult: AgentToolResult<TDetails>) => void;

	/**
	 * [pi] node_modules/@earendil-works/pi-ai/dist/types.d.ts L785 — `Model<TApi>`.
	 * Reduced to the three members pi-rp-web.ts reads: `provider` (L789, real type
	 * `ProviderId = KnownProvider | string`), `id` (L786) and `name` (L787).
	 */
	interface Model {
		id: string;
		name: string;
		provider: string;
	}

	/**
	 * [pi] dist/core/session-manager.d.ts L152 — `ReadonlySessionManager` is
	 * `Pick<SessionManager, "getCwd" | ... | "getSessionFile" | ...>`. Reduced to the two members
	 * the extension calls: `getSessionFile(): string | undefined` (L223) and
	 * `getSessionId(): string` (L222).
	 */
	interface ReadonlySessionManager {
		getSessionFile(): string | undefined;
		getSessionId(): string;
	}

	/**
	 * [pi] node_modules/@earendil-works/pi-ai/dist/types.d.ts L438-442 — `interface Context`.
	 * Only the two members pi-rp-web.ts passes are modelled (`systemPrompt`, `messages`); the real
	 * `messages: Message[]` is a discriminated union that is not worth reproducing here, so it is
	 * left as `unknown[]`. This is what makes `complete(model, "not a context")` a type error.
	 */
	interface Context {
		systemPrompt?: string;
		messages: unknown[];
	}

	/**
	 * [pi] dist/core/model-registry.d.ts L20-47 — `class ModelRegistry`.
	 * `find(provider, modelId)` (L28) and `complete<TApi>(model, context, options?)` (L37) are
	 * taken from the real declaration (`Context` above stands in for pi-ai's). The real options
	 * type is `ModelsApiStreamOptions` and the real result is `AssistantMessage`; pi-rp-web.ts
	 * widens the result to `any` immediately (L2568) and casts the options `as any` (L2571), so
	 * `unknown` is sufficient and honest for both.
	 * `runtime` is NOT part of the public class shape — the extension reaches it through
	 * `(active.context.modelRegistry as any).runtime` (L1934) — so it is declared as an optional
	 * escape hatch rather than as a real public member.
	 */
	interface ModelRegistry {
		find(provider: string, modelId: string): Model | undefined;
		complete(model: Model, context: Context, options?: unknown): Promise<unknown>;
		readonly runtime?: unknown;
	}

	/**
	 * [pi] dist/core/extensions/types.d.ts L69 — `interface ExtensionUIContext`.
	 * Only `notify(message, type?)` (L77) is called by pi-rp-web.ts, always with a
	 * "info" | "warning" literal second argument.
	 */
	interface ExtensionUIContext {
		notify(message: string, type?: "info" | "warning" | "error"): void;
	}

	/**
	 * [pi] dist/core/extensions/types.d.ts L209 — `type ExtensionMode = "tui" | "rpc" | "json" | "print"`.
	 */
	type ExtensionMode = "tui" | "rpc" | "json" | "print";

	/**
	 * [pi] dist/core/extensions/types.d.ts L210-250 — `interface ExtensionContext`.
	 *
	 * Every member below is declared because pi-rp-web.ts reads it. The members NOT declared
	 * (`mode`, `hasUI`, `scopedModels`, `thinkingLevel`, `signal`, `isProjectTrusted`,
	 * `hasPendingMessages`, `getContextUsage`, `compact`, `getSystemPrompt`) are genuinely
	 * unused by the extension, not overlooked. (`context.mode` does appear at L1484/L1490/L1568/
	 * L2001, but that is a workflow *node* context object declared in this file, not
	 * `ExtensionContext`.)
	 */
	interface ExtensionContext {
		/** [pi] L211-212. Only `ui.notify` is used (L2250, L2436, L3538, L3738, L3750, L3761). */
		ui: ExtensionUIContext;
		/** [pi] L217-218. Used as a directory root for `resolve(...)`/`relative(...)` (e.g. L2034, L2047, L2104, L3202, L3754). */
		cwd: string;
		/** [pi] L219-220, real type `ReadonlySessionManager`. Used at L1059 and L2104. */
		sessionManager: ReadonlySessionManager;
		/** [pi] L221-222, real type `ModelRegistry`. Used at L1083, L1110, L1114, L1934, L2568. */
		modelRegistry: ModelRegistry;
		/** [pi] L223-224, real type `Model<any> | undefined`. Used at L1081, L2264, L2411, L2526-2530, L3432. */
		model: Model | undefined;
		/** [pi] L233, `isIdle(): boolean`. Called at L784, L822, L2733, L2743, L3235, L3393. */
		isIdle(): boolean;
		/** [pi] L238-239, `abort(): void`. Called at L823, L2733, L2743. */
		abort(): void;
		/** [pi] L242-243, `shutdown(): void`. Called at L3769. */
		shutdown(): void;
	}

	/**
	 * [pi] dist/core/extensions/types.d.ts L255-292 — `interface ExtensionCommandContext extends
	 * ExtensionContext`. The command handlers registered by pi-rp-web.ts receive this type, so its
	 * extra members must be present for L3755, L3756, L3769 to resolve.
	 */
	interface ExtensionCommandContext extends ExtensionContext {
		/** [pi] L259, `waitForIdle(): Promise<void>`. Awaited at L3755. */
		waitForIdle(): Promise<void>;
		/** [pi] L261-267, `newSession(options?)`. Called at L3756 with only `withSession`. */
		newSession(options?: {
			parentSession?: string;
			setup?: (sessionManager: unknown) => Promise<void>;
			withSession?: (ctx: ReplacedSessionContext) => Promise<void>;
		}): Promise<{ cancelled: boolean }>;
	}

	/**
	 * [pi] dist/core/extensions/types.d.ts L298-307 — `interface ReplacedSessionContext extends
	 * ExtensionCommandContext`. Only `sendUserMessage` is called on it (L3758), with the real
	 * `(content, options?)` signature from L303-306.
	 */
	interface ReplacedSessionContext extends ExtensionCommandContext {
		sendUserMessage(
			content: string | (TextContent | ImageContent)[],
			options?: { deliverAs?: "steer" | "followUp"; expandPromptTemplates?: boolean },
		): Promise<void>;
	}

	/**
	 * [pi] dist/core/extensions/types.d.ts L896-902 — `interface RegisteredCommand`. Only
	 * `description` and `handler` are supplied by the `registerCommand` call sites (L3734, L3745,
	 * L3764), and `registerCommand` takes `Omit<RegisteredCommand, "name" | "sourceInfo">`.
	 */
	interface RegisteredCommand {
		description?: string;
		handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
	}

	/**
	 * [pi] dist/core/extensions/types.d.ts L345-378 — `interface ToolDefinition<TParams, TDetails,
	 * TState>`. `parameters` uses the `typebox` module's `TSchema` above, exactly as the real
	 * declaration does (`import type { Static, TSchema } from "typebox"`).
	 */
	interface ToolDefinition<TParams extends import("typebox").TSchema = import("typebox").TSchema, TDetails = unknown, TState = unknown> {
		name: string;
		label: string;
		description: string;
		promptSnippet?: string;
		promptGuidelines?: string[];
		parameters: TParams;
		execute(
			toolCallId: string,
			params: import("typebox").Static<TParams>,
			signal: AbortSignal | undefined,
			onUpdate: AgentToolUpdateCallback<TDetails> | undefined,
			ctx: ExtensionContext,
		): Promise<AgentToolResult<TDetails>>;
		renderCall?: (args: import("typebox").Static<TParams>, theme: unknown, context: unknown) => unknown;
		renderResult?: (result: AgentToolResult<TDetails>, options: unknown, theme: unknown, context: unknown) => unknown;
	}

	/**
	 * [pi] L417-423 — `interface SessionStartEvent`.
	 * NOT used by pi-rp-web.ts. It is retained only because the real `SessionEvent` union is
	 * declared with it; it is otherwise inert and no `pi.on` overload references it.
	 */
	interface SessionStartEvent {
		type: "session_start";
		reason: "startup" | "reload" | "new" | "resume" | "fork";
		previousSessionFile?: string;
	}
	/** [pi] L431-435 — `interface SessionBeforeSwitchEvent`. Used at L3772 via `stopBridge`. */
	interface SessionBeforeSwitchEvent {
		type: "session_before_switch";
		reason: "new" | "resume";
		targetSessionFile?: string;
	}
	/** [pi] L479-484 — `interface SessionShutdownEvent`. Used at L3773 via `stopBridge`. */
	interface SessionShutdownEvent {
		type: "session_shutdown";
		reason: "quit" | "reload" | "new" | "resume" | "fork";
		targetSessionFile?: string;
	}
	/** [pi] L855-857 — `interface SessionBeforeSwitchResult`. Return type of the L3772 handler. */
	interface SessionBeforeSwitchResult {
		cancel?: boolean;
	}

	/**
	 * [pi] dist/core/extensions/types.d.ts L907 — `type ExtensionHandler<E, R = undefined> =
	 * (event: E, ctx: ExtensionContext) => Promise<R | void> | R | void`.
	 * `stopBridge` (L1071) is `async function stopBridge()` with no parameters; that is assignable,
	 * because fewer parameters is always allowed.
	 */
	type ExtensionHandler<E, R = undefined> = (
		event: E,
		ctx: ExtensionContext,
	) => Promise<R | void> | R | void;

	/**
	 * [pi] dist/core/extensions/types.d.ts L1092-1138 — `interface ProviderConfig`.
	 *
	 * DEVIATION, deliberately loose: two members are declared as `any` because the real types live
	 * in `@earendil-works/pi-ai`/`pi-tui`, which pi-rp-web.ts does not import. The call site at
	 * L1095-1109 already ends with `} as any);`, so this only matters for keeping the *shape*
	 * checkable: `api` is really `Api = KnownApi | (string & {})` (pi-ai types.d.ts L16) and
	 * `cost` is really `ModelCost` (L781).
	 */
	interface ProviderConfig {
		name?: string;
		baseUrl?: string;
		apiKey?: string;
		api?: any;
		headers?: Record<string, string>;
		authHeader?: boolean;
		models?: unknown[];
	}
	interface ProviderModelConfig {
		id: string;
		name: string;
		api?: any;
		baseUrl?: string;
		reasoning: boolean;
		input: ("text" | "image")[];
		cost: any;
		contextWindow: number;
		maxTokens: number;
	}

	/**
	 * [pi] dist/core/extensions/types.d.ts L911-1090 — `interface ExtensionAPI`.
	 *
	 * Only the six members pi-rp-web.ts actually calls are declared:
	 *   on (L3772, L3773)                  — 2 call sites
	 *   registerTool (L3542, 3576, 3599, 3613, 3629, 3656, 3677) — 7 call sites
	 *   registerCommand (L3734, L3745, L3764) — 3 call sites
	 *   registerProvider (L1095)           — 1 call site
	 *   unregisterProvider (L2541)         — 1 call site
	 *   sendUserMessage (L3236)            — 1 call site
	 * The other real members (`registerShortcut`, `registerFlag`, `getFlag`,
	 * `registerMessageRenderer`, `registerMarkdownTransformer`, `registerEntryRenderer`,
	 * `sendMessage`, `appendEntry`, `setSessionName`, `getSessionName`, `setLabel`, `exec`,
	 * `getActiveTools`, `getAllTools`, `setActiveTools`, `getCommands`, `setModel`,
	 * `getThinkingLevel`, `setThinkingLevel`, `events`) are unused and therefore omitted.
	 */
	interface ExtensionAPI {
		/** [pi] L916 — `on(event: "session_before_switch", handler: ExtensionHandler<SessionBeforeSwitchEvent, SessionBeforeSwitchResult>): () => void`. */
		on(
			event: "session_before_switch",
			handler: ExtensionHandler<SessionBeforeSwitchEvent, SessionBeforeSwitchResult>,
		): () => void;
		/** [pi] L921 — `on(event: "session_shutdown", handler: ExtensionHandler<SessionShutdownEvent>): () => void`. */
		on(event: "session_shutdown", handler: ExtensionHandler<SessionShutdownEvent>): () => void;

		/** [pi] L950 — `registerTool<TParams extends TSchema = TSchema, TDetails = unknown, TState = any>(tool: ToolDefinition<TParams, TDetails, TState>): void`. */
		registerTool<TParams extends import("typebox").TSchema = import("typebox").TSchema, TDetails = unknown, TState = unknown>(
			tool: ToolDefinition<TParams, TDetails, TState>,
		): void;

		/** [pi] L952 — `registerCommand(name: string, options: Omit<RegisteredCommand, "name" | "sourceInfo">): void`. */
		registerCommand(name: string, options: Omit<RegisteredCommand, "name" | "sourceInfo">): void;

		/** [pi] L1072-1073 — `registerProvider(provider: Provider): void; registerProvider(name: string, config: ProviderConfig): void`. */
		registerProvider(provider: unknown): void;
		registerProvider(name: string, config: ProviderConfig): void;

		/** [pi] L1087 — `unregisterProvider(name: string): void`. */
		unregisterProvider(name: string): void;

		/** [pi] L986-989 — `sendUserMessage(content: string | (TextContent | ImageContent)[], options?: { deliverAs?: "steer" | "followUp"; expandPromptTemplates?: boolean }): void`. */
		sendUserMessage(
			content: string | (TextContent | ImageContent)[],
			options?: { deliverAs?: "steer" | "followUp"; expandPromptTemplates?: boolean },
		): void;
	}
}
