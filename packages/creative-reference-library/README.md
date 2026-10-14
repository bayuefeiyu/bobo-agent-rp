# 用户私有创作资料库 v1

独立于Pi的正式资料格式、SQLite文本检索和CLI。正式资料可供其他程序使用；项目适配层只负责Agent、模型、权限及文档交付。需要Node.js 24.14.0+，无数据库绑定依赖。使用内置SQLite worker，Web主线程不直接执行同步索引/查询。

## 转换和使用

1. 用 `convert-reference-library` Skill 分析世界书或本地文本，先向用户提交候选清单。禁用不等于排除；旧版仅在确认对应新版时建议排除。
2. 用户审查后，生成私有目录中的资料包和批准清单。没有批准清单不能入库。
3. `node packages/creative-reference-library/cli.mjs import <库根> <转换包目录> <批准清单.json>`。
4. `node packages/creative-reference-library/cli.mjs search <库根> 修仙 拍卖会 竞价`。CLI提供基础检索，不调用LLM。
5. 项目配置面板“资料库”保存库根，安装模块并对调用节点授权。`retrieve`（a）自主检索，`search-units`（b）使用普通LLM评分，`search-passages`（c）是独立的`module-external`代码工作流，直接执行向量召回和rerank，不调用普通LLM。a可以调用c；b的`includeSemanticCandidates`默认是`false`，显式启用后才会额外召回c的结果。

`status <库根>`、`read <库根> <单元ID>`、`rebuild <库根>`无需来源文件。路径参数仅属于用户CLI/配置面板，工作流请求不可指定库路径。

转卡选用正文创作或深度导演时，默认配套本模块，在方案中展示并允许明确排除。默认仅开放 b：正文在导演指导后、具体情节设计前检索一次；深度导演在现状与记忆检索后、长期推演前检索一次。单人与团队使用相同节点总额度，团队共享资料；固定关闭语义粗筛。未绑定或未就绪时跳过，其他模块暂不增加默认检索。完整接线及排除规则见[默认导入说明](../../global-modules/creative-reference-library/IMPORT.md)。

基础CLI语法为：

```text
node packages/creative-reference-library/cli.mjs import <库根> <转换包目录> <批准清单.json>
node packages/creative-reference-library/cli.mjs rebuild <库根>
node packages/creative-reference-library/cli.mjs search <库根> <关键词...>
node packages/creative-reference-library/cli.mjs read <库根> <单元ID>
node packages/creative-reference-library/cli.mjs status <库根>
```

语义索引CLI需要把配置目录作为`ROOT`之后的第一个参数：

```text
node packages/creative-reference-library/cli.mjs semantic-config <库根> <配置目录> <配置.json>
node packages/creative-reference-library/cli.mjs semantic-test <库根> <配置目录>
node packages/creative-reference-library/cli.mjs semantic-status <库根> <配置目录>
node packages/creative-reference-library/cli.mjs semantic-build <库根> <配置目录> [--force-encoding]
node packages/creative-reference-library/cli.mjs semantic-cancel <库根> <配置目录> <jobId>
node packages/creative-reference-library/cli.mjs semantic-resume <库根> <配置目录> <jobId>
node packages/creative-reference-library/cli.mjs semantic-search <库根> <配置目录> <查询词...>
```

## 正式资料

资料包 `package.json`：`{"format":"creative-reference-library/v1","id":"my-materials","units":["units/stable-id/unit.json"]}`。

`unit.json`：`{"id":"stable-id","revision":1,"title":"内容标题","summary":"概括正文","keywords":["竞价"],"aliases":[],"contentFile":"units/stable-id/content.md","relations":[]}`。contentFile相对于包根；正文UTF-8 Markdown，保留表头、条件、例外、数值和语义。独立协议不含卡、会话、模型、资料性质、适用条件、来源或机器绝对路径。ID跨改名不变，正文或检索字段修改须递增revision。

关系为`{"id":"另一单元ID","kind":"context"}`或`related`。第一版限制关系目标在同包，不自动收录未批准单元。正文应完整可理解，避免依赖任意深度关系才能成立。

交付展开必要context，最多深度2、每组4个单元，并共用数量/阅读/文本预算；放不下完整组则整体省略，不留下缺失必要条件的主单元。普通related不自动交付，Agent按需查看。

批准清单：`{"format":"creative-reference-library/v1","packageId":"my-materials","approved":true,"selectedIds":["stable-id"]}`。selectedIds必须与转换包精确一致；来源、原条目映射、用户选择和转换报告可作为额外字段存在此维护清单。只在明确审查后设置approved，不由工具替用户决定。

库根：`library.json`是当前版本指针；`versions/<generation>/packages/`存正式内容、`text.sqlite`是可重建索引；`maintenance/imports/`存独立维护记录；`staging/`存尚未发布成果。索引记录每个单元的实际内容/检索字段指纹。重建只依赖正式包。导入从上一版索引复制快照，按实际指纹更新变更行并删除移除内容；rebuild从正式包完全重建。

入库替换同ID资料包，保留其他包。同名不合并。跨包ID必须唯一。先校验审核集合和修订、构建完整新版本，再原子切换指针。跨进程mkdir写锁防止同时发布；失败保持原指针。查询固定不可变版本，旧版本首期保留，不自动清理。异常退出的`.write-lock`需用户确认没有写者后手动移除；工具不自动夺锁。

## 检索协议和限制

请求：text或keywords至少一项，可附context及降低上限的budget。默认查询8次、候选200、评分40、读取40、读取10万字、评分6万字、模型12次、输出8条/4万字；嵌套和重试共享上限。关键词与文本进入粗筛；context仅用于LLM理解，不硬过滤。

文本检索对汉字使用双字片段、对拉丁字词使用规范化词元，标题/主题词/摘要/正文独立有限召回并融合。超长查询截到64个词元。返回命中位置附近片段；超预算完整正文省略，不悄悄截断表格。评分0—100仅为排序信号，代码验证候选ID、完整性、重复及整数范围。输出只包含标题和正文；不自动写入故事事实或记忆。

内部基础查询可用fields指定title/terms/summary/body，默认全部。评分后的排序以分数为主，在接近分数间加入描述相似度的小幅惩罚，减少一组近似资料挤占其他方向；最终正文再次精确去重。候选和模型输入均有上限，通常不需要达到评分40条的数量上限。

宿主评分Agent每个子请求最多4次模型请求，自主检索最多8次，且总计不超过共享12次；格式修正和工作流重试不重置。预算在Agent底层上下文入口检查，耗尽即阻止下一次供应商请求，不依赖会继续执行的扩展事件异常。模型交付过程也计入，预算小于完成交付所需时明确失败。

数量和输出文本额度按本次固定版本中实际选中的唯一资料计数；a复用b已选资料不重复扣这两项，并通过内部selected操作取得技术ID。重复阅读、查询、评分输入及模型调用照常计数；每次交付还受自己的数量/文本上限限制。这使嵌套能够复用资料，同时不能通过重复子调用扩大唯一资料集合。

向量检索默认关闭。用户在资料库配置页保存embedding与rerank服务参数，显式测试服务后，手动构建/更新索引，也可以手动取消或恢复构建；保存配置和查询都不会自动向量化。配置关闭后停止新的semantic查询。

embedding使用完整的`embeddings` HTTP端点，rerank使用完整的Cohere-compatible `/rerank`端点；两者分别配置模型和密钥，并支持独立的query prefix、document prefix与`spaceRevision`。修改向量空间或切片参数后必须手动更新索引。

扫描使用精确Float32向量，内置硬上限为100000个片段和512MiB原始向量文件，实际采用内置上限与配置上限中较小的一项。旧索引可以搜索当前资料中未修改、未删除的子集；覆盖不足会标记`partial`，已经失效的资料在top-k之前排除。

普通Agent文件工具不能直接读库、索引、维护记录或绑定文件；绑定库时shell类工具被拦截。此边界保护正常项目工作流，不隔离同账户任意原生代码。CLI、本人和外部程序仍可访问自己的资料。

测试资料均为原创合成内容。真实模型质量尚未验证；离线mock验证协议不等于真实模型效果承诺。当前未实现ANN、自动GC、自动来源抓取或完整维护UI。

## 独立程序复用与合成向量扫描基准

`LibraryClient.open(root)` 固定版本；`RetrievalSession.search/read/compose`提供有限基础操作；`searchUnits(request, scoreCallback)`在项目之外也可以接任意普通LLM回调（返回scores对象）。关闭client以释放worker；不要在模型提示中传库根。独立核心可携带正式资料及派生索引运行，查询不依赖源文件；发布/重建逐条读取正文，内存保留有限正文及ID/路径集合；工具的显式loadPackage接口用于需要整包校验结果的维护程序。

以下是合成向量扫描基准，只扫描索引，不包含embedding、rerank或完整c工作流。Node 24.14.0、Windows本机，384维、top60、每组10轮：

可运行 `node packages/creative-reference-library/semantic-benchmark.mjs 100000 384 10`复测；参数依次为片段数、维度、轮数，工具只创建并清理临时合成索引。

| 索引片段数 | open | 首次top60 | P50 | P95 | 原始向量 | 进程RSS |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 1000 | 4.92ms | 13.57ms | 7.57ms | 13.57ms | 1.536MB | 83.8MB |
| 10000 | 29.39ms | 49.61ms | 42.66ms | 49.61ms | 15.36MB | 106.9MB |
| 100000 | 286.33ms | 412.21ms | 383.30ms | 417.09ms | 153.6MB | 190.5MB |

不同运行的缓存和磁盘负载会影响结果，表内不是速度承诺。该基准只反映向量文件打开和Float32扫描，不代表embedding、rerank、完整c工作流或真实模型质量。
