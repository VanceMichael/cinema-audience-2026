# 影厅闸机源和合作账台

`GET /gates/archives?house=值&date=值` 给物理厅、自然日、序号范围、封尾位和文件路径。文件 gzip JSON Lines，行以 `device,gen,seq` 标识，`at` 为首日零点起计的分钟，`show` 是现场场次，`allowed` 为放行字段。封尾与完整实际序号同时核对。
`GET /settlement/lines` 给影院账期、场次和已签账状态。 `POST /settlement/amend` 接场次、账行、权益编号和本次更正对应的独立观众增减。返回 202 为账台待确认，409 为目标账期当前未办。 `GET /settlement/receipts` 分账行读回实际结论。
演练 `first-house`，`late-exchange` 和 `other-house` 分别模拟旧影院结算、晚到换场及新档封尾。场次时钟与票券格式见原资料。
