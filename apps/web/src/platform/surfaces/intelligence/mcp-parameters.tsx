import { Button, Field, Select, TextArea, TextInput } from "@ehf/ui-kit";
import type { Definition } from "./model";
import styles from "./intelligence.module.css";

type Config = Extract<Definition, { serviceClass: "mcp" }>["configuration"];
type Tool = Config["tools"][number];
function Input({ label, value, onChange, hint, max = 400 }: { label: string; value: string | null; onChange: (value: string) => void; hint?: string; max?: number }) {
  return <Field label={label} hint={hint}><TextInput value={value ?? ""} maxLength={max} onChange={event => onChange(event.target.value)} /></Field>;
}
function Numeric({ label, value, onChange, max }: { label: string; value: number; onChange: (value: number) => void; max: number }) {
  return <Field label={label}><TextInput type="number" min={1} max={max} value={Number.isFinite(value) ? value : ""} onChange={event => onChange(event.target.value === "" ? Number.NaN : Number(event.target.value))} /></Field>;
}
export function McpParameters({ configuration: config, onChange }: { configuration: Config; onChange: (config: Config) => void }) {
  const patch = (value: Partial<Config>) => onChange({ ...config, ...value });
  const toolPatch = (position: number, value: Partial<Tool>) => patch({ tools: config.tools.map((tool, index) => index === position ? { ...tool, ...value } : tool) });
  return <>
    <p className={`${styles.notice} ${styles.wide}`}>Register a server and the exact tools agents may request. Saving does not connect, discover tools, execute a process or authorize tool calls. Remote discovery and invocation require a qualified MCP adapter.</p>
    <Field label="MCP transport"><Select value={config.transport} onChange={event => patch({ transport: event.target.value as Config["transport"], ...(event.target.value === "stdio" ? { identityMode: "workload" as const } : {}) })}><option value="streamable_http">Streamable HTTP</option><option value="legacy_sse">Legacy HTTP + SSE</option><option value="stdio">Managed stdio process</option></Select></Field>
    <Input label="MCP protocol revision" value={config.protocolVersion} max={10} onChange={protocolVersion => patch({ protocolVersion })} hint="Exact YYYY-MM-DD revision. Transport and discovery behavior depend on the negotiated version." />
    <Input label="Server name" value={config.serverName} onChange={serverName => patch({ serverName })} />
    <Input label="Server version / release" value={config.serverVersion} onChange={serverVersion => patch({ serverVersion })} />
    {config.transport === "stdio" ? <div className={styles.wide}><Input label="Reviewed launch-profile reference" value={config.launchProfileRef} onChange={launchProfileRef => patch({ launchProfileRef })} hint="Deployment-owned image/package, arguments, environment references and sandbox policy. No shell commands or secret values are accepted here. Set the process principal under Connection and trust." /></div> : <><Field label="Tool execution identity"><Select value={config.identityMode} onChange={event => patch({ identityMode: event.target.value as Config["identityMode"] })}><option value="workload">Service / workload identity</option><option value="delegated_user">Delegated user OAuth</option></Select></Field><Field label="Requested OAuth scopes · one per line"><TextArea value={config.scopes.join("\n")} onChange={event => patch({ scopes: event.target.value ? event.target.value.split("\n") : [] })} /></Field></>}
    <Field label="Catalog source"><Select value={config.catalogSource} onChange={event => patch({ catalogSource: event.target.value as Config["catalogSource"] })}><option value="pinned_snapshot">Register a reviewed snapshot</option><option value="review_discovery">Discover then review · worker required</option></Select></Field>
    <Input label="Tool catalog artifact reference" value={config.catalogRef} onChange={catalogRef => patch({ catalogRef })} />
    <Input label="Tool catalog SHA-256 digest" value={config.catalogDigest} max={64} onChange={value => patch({ catalogDigest: value || null })} hint="Pins tool names, schemas and server metadata in the reviewed catalog artifact." />
    <Input label="Tool access / approval policy reference" value={config.policyRef} onChange={policyRef => patch({ policyRef })} />
    <Input label="MCP conformance / evaluation reference" value={config.evaluationRef} onChange={evaluationRef => patch({ evaluationRef })} />
    <Numeric label="Tool call timeout (ms)" value={config.timeoutMs} max={600000} onChange={timeoutMs => patch({ timeoutMs })} />
    <Numeric label="Maximum concurrent tool calls" value={config.maxConcurrency} max={64} onChange={maxConcurrency => patch({ maxConcurrency })} />
    <Numeric label="Maximum result size (bytes)" value={config.maxResultBytes} max={10485760} onChange={maxResultBytes => patch({ maxResultBytes })} />
    <section className={`${styles.stack} ${styles.wide}`} aria-label="Registered MCP tools">
      <div className={styles.spread}><h3>Registered tool allowlist</h3><Button icon="plus" disabled={config.tools.length >= 50} onClick={() => patch({ tools: [...config.tools, { name: "", capabilityId: "mcp.tool.call.v1", inputSchemaRef: "", outputSchemaRef: "", effect: "read", approval: "always" }] })}>Add tool</Button></div>
      {!config.tools.length ? <p className={styles.notice}>No tools registered. The server proposal can be saved, but remains ineligible until a reviewed tool catalog is pinned.</p> : null}
      {config.tools.map((tool, position) => <fieldset className={styles.panel} key={position}><legend>Tool {position + 1}</legend><div className={styles.form}>
        <Input label={`Tool ${position + 1} name`} value={tool.name} max={128} onChange={name => toolPatch(position, { name })} hint="Exact MCP name, without wildcards." />
        <Input label={`Tool ${position + 1} capability ID`} value={tool.capabilityId} onChange={capabilityId => toolPatch(position, { capabilityId })} hint="For example mcp.customer.lookup.v1." />
        <Input label={`Tool ${position + 1} input schema reference`} value={tool.inputSchemaRef} onChange={inputSchemaRef => toolPatch(position, { inputSchemaRef })} />
        <Input label={`Tool ${position + 1} output schema reference`} value={tool.outputSchemaRef} onChange={outputSchemaRef => toolPatch(position, { outputSchemaRef })} hint="A server without outputSchema still needs a reviewed gateway result contract." />
        <Field label={`Tool ${position + 1} effect`}><Select value={tool.effect} onChange={event => toolPatch(position, { effect: event.target.value as Tool["effect"] })}>{["none", "read", "reversible", "paid", "external", "destructive"].map(value => <option value={value} key={value}>{value}</option>)}</Select></Field>
        <Field label={`Tool ${position + 1} approval`}><Select value={tool.approval} onChange={event => toolPatch(position, { approval: event.target.value as Tool["approval"] })}><option value="always">Require approval on every call</option><option value="policy">Evaluate approved policy per call</option></Select></Field>
        <Button onClick={() => patch({ tools: config.tools.filter((_, index) => index !== position) })}>Remove tool {position + 1}</Button>
      </div></fieldset>)}
    </section>
    <p className={`${styles.notice} ${styles.wide}`}>Tool-list and schema drift block use until reviewed. Tool annotations and descriptions are untrusted metadata. Capability grants, effect controls and approval remain authoritative. Resources, prompts, sampling and elicitation are outside this tool registration.</p>
  </>;
}
