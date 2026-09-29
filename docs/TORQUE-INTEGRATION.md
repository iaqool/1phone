# OnePhone как модуль допуска для Torque

Проверено по официальным страницам Torque 27.09.2026. Здесь Torque — [platform.torque.so](https://platform.torque.so/docs), сервис кампаний в Solana. Доступ к живому проекту Torque и реальная выплата пока не проверялись.

## Подтверждённый интерфейс Torque

- [Data Sources](https://platform.torque.so/docs/mcp/tools/data-sources): Torque может индексировать выбранные Anchor-инструкции после `create_idl`/`create_instruction`, либо принимать custom events через `POST https://ingest.torque.so/events`. Последний требует `x-api-key`, `userPubkey`, `timestamp`, `eventName`, `data`. Это источники данных для запросов, а не синхронная проверка права при выплате.
- [Query Builder](https://platform.torque.so/docs/mcp/tools/query-builder): `generate_incentive_query` поддерживает `source: "idl_instruction"` и `"custom_event"`. У IDL-источника группировка по умолчанию идёт по **fee payer**, а не обязательно по SGT holder; привязку аккаунтов надо проверить на фактическом preview.
- [Incentives](https://platform.torque.so/docs/mcp/tools/incentives) и [типы выплат](https://platform.torque.so/docs/mcp/reference/incentive-types): `create_recurring_incentive` с `type: "direct"` принимает массив `{address, amount}`; `maxIterations: 1` ограничивает число эпох одной, `evalDurationDays: 1` задаёт её длительность. Для `direct` выплаты берутся из предоставленных allocations. Указаны 5% protocol fee сверх финансируемой суммы и семидневное окно claim; перед созданием нужен `confirmed: false` preview. Создание live incentive требует Torque auth, активного проекта и финансирования.
- [Configuration](https://platform.torque.so/docs/mcp/configuration) и [Quick Start](https://platform.torque.so/docs/mcp/quickstart): документирован MCP-пакет `@torque-labs/mcp`, авторизация через Torque account/token. Локальное формирование JSON не требует ключа. Здесь не выполняется запрос к Torque и не используется закрытый HTTP API.

Публичная документация на этих страницах не описывает hook проверки OnePhone внутри транзакции выплаты Torque, CPI `consume+pay`, атомарный протокол, гарантию идемпотентности событий или запрет повторного создания direct incentive. Поэтому OnePhone гарантирует только уникальность **регистрации допуска**, а не единственность/доставку внешней выплаты. Повторный административный запуск Torque с тем же списком потенциально выплатит ещё раз. Для более сильной гарантии нужен подтверждённый контракт Torque по payout enforcement и сверке статусов.

## Локальный контракт OnePhone

`register_namespace(scope, deadline)` создаёт неизменяемый Namespace PDA от `authority + scope`; нулевой scope и прошедший deadline отвергаются. `scope = SHA-256(domain || len(project) || project || len(reference) || reference)`, где `domain` — UTF-8 байты `onephone:torque:namespace:v1` и нулевой байт, длины — 16-битные big-endian длины UTF-8 байтов. `project` и `reference` — согласованные оператором строки. Хэш локально разделяет кампании; Torque не знает о такой связи автоматически. Оператор должен выбрать соответствующий активный Torque project.

`consume` здесь означает **регистрацию допуска, без выплаты**. Подписант должен сейчас владеть настоящим SGT: программа проверяет Token-2022, mint authority, metadata pointer, group/member, holder token account и баланс 1; frozen account допустим. До deadline создаётся неизменяемый `EligibilityReceipt PDA(namespace, sgt_mint)` с namespace, mint, holder и chain timestamp. Тот же SGT mint в том же namespace не может зарегистрироваться второй раз даже после переноса к другому кошельку или двух конкурентных заявок. Другой namespace независим. Старый `claim` с собственным vault оставлен для регресса, но Torque-экспортёр его `Receipt` не включает.

После закрытия окна локальный read-only экспортёр получает `Clock` и Namespace на уровне `finalized`, затем читает только аккаунты программы размера EligibilityReceipt с этим namespace и `minContextSlot` не ниже snapshot. Он проверяет owner, discriminator, поля, PDA и timestamp, отвергает пустой/испорченный список; по одному SGT допускается одна запись, по одному кошельку несколько SGT дают **одну** allocation. Выход сортируется по адресу. Размер суммы задаёт оператор в SOL десятичной строкой с максимум 9 знаками; экспортёр отвергает потерю точности при переводе в число Torque. `startDate` требует часовой пояс и время позже финализированного chain snapshot. JSON содержит audit (program ID, namespace, authority, scope, project/reference, слот и chain time) и `create_recurring_incentive` arguments с `type: direct`, `emissionType: SOL`, `maxIterations: 1`, `confirmed: false`.

Локальный вызов после развёртывания программы и закрытия окна:

```powershell
$env:SOLANA_RPC_URL = 'https://YOUR_SOLANA_RPC'
npm run torque:preview -- NAMESPACE AUTHORITY PROJECT REFERENCE 'OnePhone reward' 0.1 2026-10-01T00:00:00Z
```

`NAMESPACE` должен совпасть с PDA из `AUTHORITY/PROJECT/REFERENCE`. По умолчанию RPC — локальный validator. Команда только читает chain и печатает JSON; она не создаёт incentive и не списывает средства. Для реального Torque нужно вручную сверить audit/allocations, стоимость и активный project, вызвать документированный preview в Torque, а затем отдельно подтвердить создание. Публичный адрес настоящего SGT и доступ к Torque ещё не предоставлены; локальные fixtures синтетические.
