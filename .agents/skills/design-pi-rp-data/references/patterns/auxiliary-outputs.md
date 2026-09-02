# Auxiliary-output pattern

An authored status panel, meanwhile scene, thought channel, commentary, choice list, summary, or other output outside the main narrative is a feature-module record type, not additional chat prose and not a separate output storage engine.

Keep activation, content rules, and formatting guidance in the owning module Skill. Generate the record from an authorized ordinary workflow node. Use named views for any later Agent retrieval and a frontend view for display. The frontend does not own the output data.

Separate ephemeral presentation from durable state. If an output can be regenerated and is not queried later, a scoped workflow artifact may be sufficient. If it must persist, be displayed on resume, affect future turns, or be queried, submit it to the owning collection.

Do not let an auxiliary-output node emit another main narrative. Define its message binding and suffix-pruning behavior when the output belongs to one turn.
