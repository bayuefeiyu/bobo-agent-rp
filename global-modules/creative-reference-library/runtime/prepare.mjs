export async function execute({ run, services, node }) {
  const request = { text: run.textInput || "", keywords: run.arguments?.keywords || [], context: run.arguments?.context || "", budget: run.arguments?.budget || {}, includeSemanticCandidates: run.arguments?.includeSemanticCandidates ?? false };
  if (node.metadata.mode === "retrieve") return services.referenceLibrary.initialize(request);
  return services.referenceLibrary.prepare(request);
}
