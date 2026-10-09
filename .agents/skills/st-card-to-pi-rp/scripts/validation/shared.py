"""校验层共享的协议常量（S8 拆分第 0 层）。

为什么单独成模块：这些常量被**多个**校验层同时使用（manifest/provenance、工作流、模块资源），
若把它们留在主校验器里而让子模块反向导入主模块，就会形成循环导入。放在无依赖的底层模块，
各层按需导入即可。

**取值与拆分前逐字一致**；仅位置变化（由脚本从原文件原样搬出，未重新录入）。
"""
from __future__ import annotations

import re

ALLOWED_STATUSES = {"mapped", "metadata-only", "unsupported", "unresolved", "duplicate"}

ALLOWED_TRANSFORMS = {
    "verbatim",
    "format-only",
    "split",
    "merged",
    "summary-anchor",
    "bridge",
    "generated-runtime",
}

RUNTIME_SERVICES = {"random"}

CHARACTER_MACROS = ("{{char}}", "<char>", "<bot>")

PLAYER_MACROS = ("{{user}}", "<user>")

STRUCTURAL_FIELDS = {"id", "moduleId", "collectionId", "recordType", "source", "target", "path", "file", "entryFile", "skillFile", "dataContractFile", "resourceCatalogFile", "frontendViewFile"}

SHIPPED_FOREGROUND_TEMPLATES = {"standard-rp", "advanced-memory-rp"}

SHIPPED_MEMORY_FOREGROUND_TEMPLATES = {"advanced-memory-rp"}

NARRATIVE_AGENT_REQUIRED_CALLS = ["narrative-memory/narrative-memory-retrieve"]

DESIGN_WARNING_PREFIX = "design: "

DESIGN_INVARIANT_FIELDS = {
    "foregroundWorkflow",
    "requiresCardContextResources",
    "requiresEffectiveMemoryTimeline",
    "requiresNarrativeAgentCallable",
}

WRITE_ACTIONS = {"create", "update", "append", "revise", "archive", "restore", "delete"}

TRIGGER_DOCUMENT_READ = re.compile(r"""["'`]trigger/([A-Za-z0-9._-]+)""")
