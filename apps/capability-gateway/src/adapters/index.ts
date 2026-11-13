import { contextSalesforceModule, contextFenergoModule } from "./context-api.js";
import { contextDocumentsModule } from "./context-documents.js";
import { contextPostgresModule } from "./context-postgres.js";
import { contextSourceModule } from "./context-source.js";
import { decisionsModule } from "./decisions.js";
import { documentModelModule } from "./document-model.js";
import { databricksServingModule, databricksUcModule, databricksVectorModule } from "./databricks.js";
import { evidenceModule } from "./evidence.js";
import { corpusModule } from "./corpus.js";
import { foundryAgentModule } from "./foundry-agent.js";
import { httpOperationModule } from "./http-operation.js";
import { openRouterModule } from "./openrouter.js";
import { openSanctionsModule } from "./opensanctions.js";
import { pgvectorModule } from "./pgvector.js";
import { simulatorModule } from "./simulator.js";
import { skillsModule } from "./skills.js";
import type { CapabilityAdapterModule } from "./types.js";
import { wiringModule } from "./wiring.js";

/**
 * Every adapter module this gateway can load, in registration order. Adding an adapter is
 * adding a module here; GATEWAY_ADAPTERS decides which are enabled in a deployment.
 */
export const ADAPTER_MODULES: readonly CapabilityAdapterModule[] = [
  simulatorModule,
  openSanctionsModule,
  wiringModule,
  evidenceModule,
  pgvectorModule,
  openRouterModule,
  documentModelModule,
  foundryAgentModule,
  databricksServingModule,
  databricksVectorModule,
  databricksUcModule,
  httpOperationModule,
  skillsModule,
  corpusModule,
  contextPostgresModule,
  contextSalesforceModule,
  contextFenergoModule,
  contextDocumentsModule,
  contextSourceModule,
  decisionsModule,
];

export type {
  AdapterBindingOption,
  AdapterCloud,
  AdapterDescriptor,
  AdapterInvocationContext,
  AdapterModuleDeps,
  CapabilityAdapterModule,
  ConnectorTemplateSpec,
  ExecutableAdapter,
} from "./types.js";
