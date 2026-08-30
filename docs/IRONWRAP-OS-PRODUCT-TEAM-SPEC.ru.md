# IronWrap OS: спецификация продукта и разработки

> **Класс документа:** разработческое обобщение и руководство по реализации<br>
> **Снимок:** `main` на коммите `1e1d7ab0da3d5cb4b46b7a52dd4e332fdc68d956`, проверено 2026-08-30<br>
> **Аудитория:** продукт, дизайн, frontend, backend, данные, AI, безопасность, QA, операции, compliance и руководство<br>
> **Статус:** рабочая спецификация для синхронизации команды; она не создает деловые, юридические, безопасностные, бухгалтерские или релизные полномочия<br>
> **Операционное приложение:** [Роли, процессы, интеграции, сценарии и UI-доказательства](./IRONWRAP-OS-OPERATIONS-AND-UI-ANNEX.ru.md)<br>
> **Визуальное приложение:** [Атлас продукта IronWrap OS](./diagrams/ironwrap-os-product-atlas.ru.html)

[English version](./IRONWRAP-OS-PRODUCT-TEAM-SPEC.md)

## 1. Как пользоваться этой спецификацией

Этот документ объединяет канонические контракты IronWrap и текущий исполняемый код в одно
описание продукта для всей команды. Это обобщение, а не второй источник истины. При конфликте
приоритет имеет документ-владелец:

1. [`DOCUMENTATION-CONTRACT.md`](./DOCUMENTATION-CONTRACT.md) определяет правила документации и заявлений о доказанности.
2. [`AI-NATIVE-ARCHITECTURE.md`](./AI-NATIVE-ARCHITECTURE.md) определяет архитектуру и границы продукта.
3. [`AUTONOMOUS-OPERATING-SYSTEM.md`](./AUTONOMOUS-OPERATING-SYSTEM.md) определяет контур компании и постоянные операционные функции.
4. [`AUTHORITY-AND-EVIDENCE-CONTRACT.md`](./AUTHORITY-AND-EVIDENCE-CONTRACT.md) определяет актеров, полномочия, доказательства, переходы, эффекты и деградированный режим.
5. [`CAPABILITY-MATRIX.md`](./CAPABILITY-MATRIX.md) определяет изменяемое состояние реализации, пробелы и этапы поставки.
6. [`COMPLIANCE-REGISTER.md`](./COMPLIANCE-REGISTER.md) определяет исследованные регуляторные триггеры и обязательные человеческие подписи.

Каждое утверждение о возможности использует один из следующих статусов доказанности:

| Метка | Значение |
|---|---|
| **Реализовано в исходном коде** | В этом checkout существует исполняемый маршрут, компонент, обработчик, схема или тест. |
| **Проверено локально** | Именованная локальная проверка прошла на точном checkout. |
| **Настроено** | В именованной среде присутствует необходимая конфигурация tenant, провайдера и политики. |
| **Подтверждено в runtime** | Развернутый маршрут и его зависимости были реально вызваны с контрольным чтением. |
| **Подтверждено бизнесом** | Контролируемый сквозной операционный сценарий прошел с приемкой ответственного человека. |
| **Подтверждено клиентом** | Реальный клиентский сценарий прошел отдельные юридические, операционные и UX-критерии. |
| **Частично** | Часть авторитетного пути существует, но обязательная поверхность, провайдер, политика или доказательство еще отсутствует. |
| **Целевое состояние** | Обязательное поведение продукта, которое еще не полностью реализовано и доказано. |

Наличие кода не означает merge, deploy, конфигурацию, работоспособность среды, бизнес-приемку или
production proof.

## 2. Определение продукта

### 2.1 Видение

IronWrap OS является операционной системой с приоритетом доказательств для управляемой владельцем
компании в сферах кровельных работ, наружных конструкций, сервиса, изготовления металла и поставки
материалов. Небольшая ответственная команда должна вести компанию через один управляемый
операционный поток: от первого обращения до принятого объема, безопасного выполнения на объекте,
бухгалтерской сверки, закрытия и сервиса. При этом программа и AI не получают полномочия, которые
принадлежат человеку, регулятору, клиенту, профессионалу или внешнему провайдеру.

### 2.2 Обещание продукта

Для каждого существенного решения по работе IronWrap OS должен отвечать на шесть вопросов:

1. **Что является истиной?** Текущий версионированный факт и система, которая им владеет.
2. **Кто вправе действовать?** Аутентифицированный актер, роль, делегирование, назначение или внешний уполномоченный источник.
3. **Какие доказательства это подтверждают?** Неизменяемое исходное, производное, физическое, полномочное, финансовое, решающее или отрицательное доказательство.
4. **Какая политика разрешила или заблокировала действие?** Точная проверенная версия и коды причин.
5. **Что произошло за пределами системы?** Эффект у провайдера, клиента, поставщика или органа, контрольное чтение, сверка либо известная неоднозначность.
6. **Что должно произойти дальше?** Ограниченная задача, gate, исключение или человеческое решение с владельцем.

### 2.3 Стратегические результаты

Продукт успешен, когда он:

- сокращает время от лида до решения и от принятой работы до готового задания, не пропуская доказательства;
- защищает маржу, связывая измерения, объем, ревизии, цену, изменения, закупку, выход материала, завершение и бухгалтерское readback;
- делает выпуск небезопасной, несанкционированной, устаревшей, противоречивой или несверенной работы явно невозможным;
- дает каждой роли небольшую ежедневную поверхность вместо универсальной базы данных;
- сохраняет безопасность и атрибуцию полевой работы при потере сети;
- позволяет владельцу управлять политикой, капиталом и существенными исключениями, а не обычным вводом данных;
- заменяет изменяемые статусы провайдеров и устные знания об интеграциях собственными ID, манифестами, квитанциями и сверкой;
- добавляет AI как ограниченный слой предложений и координации, но не как неподконтрольный источник истины.

### 2.4 Что продуктом не является

IronWrap OS не является:

- универсальной горизонтальной CRM, ERP, бухгалтерской системой, доской проектов или чат-ботом;
- заменой QuickBooks как источника проведенной бухгалтерской истины либо внешних регуляторных и профессиональных полномочий;
- автономным контроллером физической работы;
- страховым оценщиком, кредитором, инженером-конструктором, юридическим советником или издателем разрешений;
- вторым источником истины для проектов и дизайна Facet;
- обещанием, что каждый видимый в коде маршрут настроен и работает в production;
- единым записываемым `job_status`, который смешивает независимые жизненные циклы бизнеса.

## 3. Границы бизнеса и услуг

IronWrap одновременно работает как восемь связанных бизнесов: строительный подрядчик;
производитель металлических изделий и продавец материалов; организация продаж, маркетинга и
сервиса; работодатель и менеджер субподрядчиков; организация безопасности, качества и
экологического контроля; оператор склада, автопарка, оборудования и площадок; финансовая,
налоговая, договорная, privacy и гарантийная сущность; управляемая владельцем программная и
автоматизационная платформа.

### 3.1 Включенный продуктовый контур

- Жилые и коммерческие кровельные и наружные работы в пределах заявленной компетенции компании.
- Инспекция, измерение, расчет, контролируемое проектирование системы, предложение цены, договор и изменения.
- Ремонт, дефекты, гарантия, жалобы и работа с service case.
- Подготовка, закупка, склад, планирование, dispatch и выполнение на объекте.
- Планирование листового металла, контролируемое изготовление, качество, custody пакетов и supply-only работа.
- Автопарк, прицепы, оборудование, груз, инспекция, дефект, обслуживание и custody-контроль.
- Циклы клиента, поставщика, субподрядчика, сотрудника, полномочий, безопасности, качества, финансов и аудита.
- Работа с двумя брендами и tenant-scoped конфигурацией в пределах разрешенного каноническими контрактами.

### 3.2 Работа с отдельными полномочиями или вне контура

Система обязана отказать, перенаправить или потребовать реальные внешние полномочия для работы за
пределами заявленной компетенции. Это включает конструктивное проектирование, удаление опасных
материалов, ограниченные электрические, солнечные, водопроводные, газовые и механические работы,
инженерный подъем, страховую корректировку, кредитный андеррайтинг и любую работу вне лицензии,
разрешения, требований производителя, страховщика, географии или делегирования.

## 4. Принципы продукта

1. **Сначала собственный источник истины.** D1 и управляющий Worker владеют внутренними операционными фактами и переходами. Записи провайдера являются ограниченной внешней истиной, но не заменяют собственные ID.
2. **Доказательство до эффекта.** Внешний эффект до исполнения связывает точный ввод, актера, полномочия, доказательства, политику, идемпотентность и ожидаемое контрольное чтение.
3. **Ортогональные состояния.** Лид, коммерческие ревизии, production gates, назначения, work packages, безопасность, бухгалтерия, closeout, гарантия и сервис остаются независимыми авторитетными автоматами.
4. **Производные представления только для чтения.** Boards, Now, dashboards и `job_phase` объясняют факты. Перемещение карточки или изменение проекции не может обойти владеющую команду.
5. **Права людей и внешних органов являются жесткими границами.** Никакая цель не отменяет право остановки работ, права клиента, доступность, privacy, трудовое право, регулятора, инженера, страховщика или issuer.
6. **Offline означает безопасно, а не оптимистично.** Кэшированные инструкции и stop-контроли остаются доступны. Новая существенная работа не начинается на основании устаревших полномочий.
7. **Неоднозначность является долговечным состоянием.** Таймаут и неизвестный результат провайдера создают исключение, а не скрытый повтор с дублированным эффектом.
8. **Конфигурация является версионированным поведением продукта.** Pipelines, поля, формы, документы, recipients, интеграции, роли и operating profiles требуют истории, полномочий, rollback и доказательства.
9. **Одно событие, много представлений.** Каналы могут отличаться, но команды и долговечные факты сходятся в одном управляемом ядре.
10. **Классы доказанности не смешиваются.** Код, тесты, CI, merge, deploy, runtime, бизнес-приемка и клиентская проверка сообщаются отдельно.

## 5. Пользователи, роли и их задачи

### 5.1 Аутентифицированные роли продукта

| Роль | Главная задача | Основной фокус продукта | Граница полномочий |
|---|---|---|---|
| `owner` | Видеть существенные исключения, решения по политике и капиталу, риск, деньги и здоровье операций | Now, Reception, Board, Sales, Designs, Production, Service, Today, Inventory, Approvals, Settings | Делегирование и segregation of duties сохраняются; владелец не может создать внешние полномочия. |
| `ops` | Превратить спрос в полную, запланированную и незаблокированную работу и разрешать операционные исключения | Те же широкие операционные поверхности, что у owner, в пределах разрешений | Не может отменять жесткие safety, legal, customer, accounting или evidence gates. |
| `sales` | Квалифицировать допустимую работу и сформировать точное, проверяемое решение клиента | Now, Sales, Board | Не может связывать неподтвержденные claims, устаревшие ревизии, депозиты или работу вне полномочий. |
| `production` | Выпускать и координировать безопасную, готовую и атрибутированную физическую работу | Now, Production | Не может планировать через незакрытый gate или самостоятельно подтверждать собственное качество там, где требуется разделение. |
| `accounting` | Превратить одобренные intents в проведенную и сверенную истину провайдера | Money, Exceptions, Now, QuickBooks settings | Не может выводить факт оплаты или posting из webhook, screenshot или запрошенного эффекта. |
| `field` | Безопасно выполнить текущий work package и с минимальным трением собрать обязательные доказательства | Now, Check-in, Vehicle, Inventory | Может остановить работу; не может выдумывать объем, изменение скрытых условий, completion или полномочия. |

### 5.2 Другие актеры

| Актер | Отношение к продукту | Обязательное поведение |
|---|---|---|
| Клиент или уполномоченный контакт | Estimate, выбор, acceptance, service, correction, complaint, status | Проверять identity и полномочия на решение; сохранять точное содержание показа и решения. |
| Поставщик или субподрядчик | Quote, order, acknowledgement, delivery, clearance, work evidence | Связывать identity компании, scope, версии, доказательства и сверку. |
| Внешний уполномоченный источник | Permit, inspection, WCB, manufacturer, engineer, insurer, tax, legal | Считать авторитетным только в точном контуре; проверять freshness, revocation и issuer readback. |
| Устройство | Камера, телефон, станок, автомобиль, sensor | Регистрировать identity, пользователя или custody, calibration при необходимости, время и integrity. |
| AI agent | Анализировать, вычислять, готовить черновики, сравнивать и предлагать ограниченные планы | Максимум полномочий модели: `observe`, `derive`, `propose`; никаких credentials или универсальных mutation tools. |
| Детерминированный coordinator | Проверять policy, потреблять permits, исполнять registered actions и сверять | Может commit только точное разрешенное действие и обязан записать terminal readback либо exception. |

## 6. Архитектура пользовательского опыта

### 6.1 Поверхности продукта

PWA является основной ролевой пользовательской поверхностью. Текущий код включает:

- публичный вход, проверку и pairing аутентификации, portal, contract acceptance и estimator;
- ролевой дом `/now`, дневную очередь `/today`, job packet и универсальные страницы work object;
- field check-in, vehicle и inventory;
- owner view, approvals, Newo administration, service и review marketing intent;
- accounting intents, exceptions, QuickBooks connection и detail final invoice;
- Facet designs, production, sales desk, sales board, owner board, lead capture и triage, measurement и estimate, approval quote revision;
- settings для company, team, devices, integrations, configuration, pipelines, fields, automations, recipients и documents;
- permission-scoped палитру operator search с клавиатурным вызовом в текущем коде.

Маршруты подтверждают наличие интерфейса, но не конфигурацию провайдера и не поведение развернутой среды.

### 6.2 Навигация по ролям

| Поверхность | Owner | Ops | Sales | Production | Accounting | Field |
|---|---:|---:|---:|---:|---:|---:|
| Now | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Reception | ✓ | ✓ | - | - | - | - |
| Board | ✓ | ✓ | ✓ | - | - | - |
| Sales | ✓ | ✓ | ✓ | - | - | - |
| Designs | ✓ | ✓ | - | - | - | - |
| Production | ✓ | ✓ | - | ✓ | - | - |
| Service | ✓ | ✓ | - | - | - | - |
| Today | ✓ | ✓ | - | - | - | - |
| Inventory | ✓ | ✓ | - | - | - | ✓ |
| Approvals | ✓ | ✓ | - | - | - | - |
| Money / Exceptions | Через permissions | Через permissions | - | - | ✓ | - |
| Check-in / Vehicle | Через permissions | Через permissions | - | - | - | ✓ |
| Settings | ✓ | ✓ | - | - | QuickBooks scope | - |

Точный доступ к маршрутам продолжает определяться `app/src/lib/roles.ts` и серверными permissions.
Эта таблица является продуктовым резюме, а не реализацией авторизации.

### 6.3 Контракт взаимодействия

- Каждый экран показывает текущий факт, источник, версию или freshness и следующее допустимое действие.
- Разрушительное или внешнее действие показывает влияние, актера, точную цель, доказательства и состояние approval.
- Недоступное действие объясняет причину блокировки и ответственный путь исправления.
- Перемещение на доске выпускает typed versioned command и никогда напрямую не пишет презентационный статус.
- Формы объявляют обязательные evidence, offline policy, sensitivity, correction behavior и field-level authority.
- Существенные решения клиента сохраняют точную ревизию, условия, assumptions, exclusions, цену и показанное содержание.
- Все поверхности предоставляют ясный путь к человеку для клиента, работника и exception-сценария.

## 7. Сквозной операционный жизненный цикл

IronWrap является графом автоматов состояний. Обычный успешный путь выглядит так:

1. Захватить lead с channel, consent, identity, brand, property, need и raw source evidence.
2. Проверить service fit, urgency, location, authority, risk, duplication и next action.
3. Квалифицировать или дисквалифицировать с причиной; создавать и активировать owned customer, property и job identity только через принятый transition.
4. Запланировать и выполнить inspection или measurement; записать source provenance, uncertainty, hazards, calibration и conflicts. Facet может выдать attributable design evidence.
5. Сформировать controlled scope и options, затем versioned quote из принятых inputs, assemblies, pricing, exclusions и risk rules.
6. Одобрить точную quote revision, если требуется, создать точную proposal или publication revision и записать delivery readback.
7. Проверить identity и полномочия клиента; связать acceptance, rejection, cancellation или requested change с точной текущей publication.
8. Вывести deposit intent из принятой commercial truth; выполнить через accounting provider только при наличии конфигурации и сверить provider readback.
9. Проверить независимые production gates: contract, deposit, permit и authority, design и scope, materials, crew и competency/WCB, safety, weather и access, equipment и cargo, а также другие work-specific controls.
10. Создать versioned assignment, выпустить точный work package и собрать acknowledgements.
11. Выполнить физическую работу с check-in, evidence slots, safety stops, hold points, quality, inventory/material movement, changes, delays, incidents и custody.
12. Принять completion packet только после удовлетворения обязательных физических, качественных, клиентских, документальных и deficiency-фактов.
13. Вывести final-invoice intent; выполнить и сверить posting, payment, credit или refund, holdback и tax согласно одобренной provider policy.
14. Передать closeout, архивировать controlled evidence, объявить warranty facts и открывать service cases без переписывания истории исходной работы.

### 7.1 Входные и выходные gates

| Этап | Условие входа | Доказательство выхода | Типичный жесткий stop |
|---|---|---|---|
| Intake | Аутентифицированный канал или ограниченная публичная сессия | Атрибутированный lead и consent/source evidence | отсутствующая identity, suppression, неоднозначный duplicate |
| Qualification | Существует triage context | Решение qualified/disqualified с причиной | работа или полномочия вне контура |
| Survey/design | Qualified opportunity или job и разрешенный визит | Атрибутированная measurement/design revision | небезопасный доступ, конфликт, некалиброванный источник |
| Commercial | Принятые source inputs и pricing policy | Текущая опубликованная revision и delivery readback | unsupported claim, stale inputs, неутвержденное нарушение price floor |
| Customer decision | Проверенный decision-maker видит точную revision | Неизменяемое acceptance/rejection/change decision | identity или authority mismatch, revision drift |
| Deposit | Binding acceptance и настроенный accounting mapping | Provider posting/payment reconciliation либо явный exception | tax, mapping или provider ambiguity |
| Production readiness | Accepted scope плюс применимый набор gates | Все обязательные текущие gates готовы | stale permit/WCB/weather, отсутствие material/crew/access |
| Dispatch | Ready job и capacity без конфликтов | Current append-only assignment и acknowledged package | predecessor, version или custody conflict |
| Execution | Valid assignment, work package, hazard plan и hold releases | Обязательные physical, quality и change evidence | safety stop, hidden condition, unapproved change |
| Closeout | Факты substantial completion | Accepted completion packet и controlled archive | deficiency, missing inspection/document |
| Financial closure | Accepted completion и current invoice intent | Reconciled provider balance | mismatch, dispute, open credit/holdback |
| Service/warranty | Valid customer/property/job/asset relationship | Verified remedy, customer decision и recovery reconciliation | ambiguity в responsibility, coverage или authority |

## 8. Подробные пользовательские потоки

### UF-01: исключение владельца до управляемого разрешения

**Триггер:** существенное exception, approval, stop, provider ambiguity, policy decision или overdue
control попадает в контур owner.

1. Owner аутентифицируется и открывает **Now** или **Approvals**.
2. Система группирует исключения по severity, deadline, job/customer, accountable function и reason code, не скрывая source conflicts.
3. Owner открывает элемент и видит current facts, versions, evidence, prior decisions, policy result, financial/customer/safety impact и recommended options.
4. Owner может approve, reject, запросить информацию, назначить, локализовать или abstain в пределах точных полномочий.
5. Система записывает immutable decision и при необходимости создает permitted internal или external effect. Browser не может отметить provider effect успешным.
6. Executor получает readback и reconciliation либо записывает ambiguous/manual exception.
7. Now удаляет элемент только после terminal, independently verifiable состояния владеющего автомата.

**Приемка:** approval не может обойти hard stop; каждый разрешенный элемент сохраняет decision-maker,
evidence, policy, effect, readback и closure proof.

### UF-02: reception и ops от лида до qualified job

1. Захватить phone, web, portal, import или internal lead с brand, identity, contact preference, consent, property, request, urgency и raw source.
2. Обнаружить вероятный duplicate person/property/lead и показать варианты reconciliation.
3. Проверить serviceability, geography, customer authority, safety, claim language, complexity и required inspection.
4. Запросить недостающую информацию через разрешенный channel с учетом suppression и timing rules.
5. Qualify, disqualify или hold со stable reasons.
6. При accepted conversion атомарно создать или активировать owned customer, property и roof-job relationship; provider IDs остаются mappings.
7. Создать следующий appointment или work item с actor, deadline и prerequisites.

**Поведение при сбое:** retry duplicate-safe; конфликт identity или consent закрывается в owned exception.

### UF-03: sales от лида до принятой коммерческой ревизии

1. Открыть qualified lead или job в Sales Desk.
2. Подтвердить customer/property identity, authority, need, service fit и current evidence.
3. Запросить или проверить measurements, Facet evidence, hazards, scope assumptions, controlled products и exclusions.
4. Построить quote revision; система показывает price inputs, uncertainty, margin/risk controls и evidence lineage.
5. Отправить точную revision на обязательный approval; stale или superseded revision нельзя публиковать.
6. Создать и опубликовать proposal/contract revision через configured channel и записать delivery readback.
7. Клиент видит точную current revision, disclosures, options, consequences и person path.
8. Проверенный клиент accepts, rejects, cancels или requests change; decision связывается с этой revision.
9. Acceptance выводит deposit intent и commercial facts, но не утверждает provider payment.

**Приемка:** price, scope и terms не расходятся между approval, publication, customer display и
acceptance; каждое изменение создает новую revision.

### UF-04: production от принятой работы до выпущенного work package

1. Production открывает job и читает derived phase вместе с независимыми gate statuses.
2. Система проверяет текущий required gate set для work type, jurisdiction, brand, customer, property, crew, materials, weather, access, equipment и authority.
3. Production устраняет missing facts через owning workflow. Waiver возможен только при явном разрешении policy и с accountable actor.
4. Создать или supersede assignment после проверок conflict, capacity, competence, WCB, vehicle/cargo и predecessor.
5. Сгенерировать и выпустить work package с точными scope, location, versions, hazard plan, instructions, evidence slots, hold points, emergency contacts, stop conditions и expiry.
6. Назначенные работники подтверждают package на своих devices; измененный package требует нового acknowledgement.
7. Job появляется в Today или field view только в пределах текущих assignment и package authority.

**Приемка:** презентация schedule не может выпустить blocked work; stale evidence инвалидирует
соответствующий gate до старта.

### UF-05: дневное назначение field, offline-выполнение, stop и completion

1. Работник входит на paired device и загружает **Now/Today** при наличии сети.
2. Device кэширует последний valid assigned work package, hazard plan, emergency contacts, evidence requirements и stop controls.
3. Работник делает check-in в точные job и assignment и подтверждает current package.
4. Start принимается online только после сохранения всех независимых hold releases.
5. При потере сети работник читает cached instructions, собирает упорядоченные attributable evidence, записывает разрешенный progress и может отправить stop/emergency action.
6. Работник не может начать новый consequential scope, одобрить change, release safety stop или вывести completion из offline queue.
7. После reconnect queued actions воспроизводятся по порядку со stable idempotency keys и version checks.
8. Конфликты становятся явными exceptions; ничто молча не перезаписывает более новые authority facts.
9. Completion требует объявленных evidence slots, hold-point и quality decisions, material/change facts и attestations ответственных актеров.

**Приемка:** valid stop действует немедленно и не может быть overridden; replay дает не более одного
committed transition на idempotency key.

### UF-06: accounting от intent до сверки провайдера

1. Accounting открывает Money/Exceptions и выбирает deposit, final-invoice, credit, refund, tax или другой supported intent.
2. Система показывает точные source commercial/completion facts, amount/currency/entity, mapping, tax policy, provider identity, approvals и prior attempts.
3. Accounting исправляет missing configuration или approves с учетом segregation-of-duties.
4. Executor потребляет registered permit и отправляет одно idempotent provider action.
5. Provider acknowledgement или webhook сохраняется как evidence, но сам по себе не доказывает posting или payment.
6. Система читает provider detail, связывает immutable external IDs, сравнивает material fields и записывает reconciled, rejected, compensated, not-executed, ambiguous или manual-exception outcome.
7. Derived job phase обновляется только из authoritative accounting и completion facts.

**Приемка:** duplicates, partial failure, amount/entity/tax mismatch и unknown timeout видимы и
восстановимы без выдуманного успеха.

### UF-07: customer estimate, решение по договору, status и service

1. Клиент входит через approved public estimator, portal, proposal или service link.
2. Система идентифицирует business/brand, раскрывает automation или recording там, где требуется, и собирает consent и accessibility/channel preferences.
3. Estimate experience отделяет assumptions и non-binding range от quote, contract, invoice, receipt и warranty.
4. Для consequential decision система проверяет identity и authority и показывает exact immutable revision с exclusions, changes, consequences, cancellation, correction и complaint paths.
5. Сохраняются customer decision и content presented.
6. Portal status показывает только authorized customer-safe facts и предоставляет person path.
7. Service intake связывает customer, property, job, asset, warranty и consent, обнаруживает duplicates и запускает triage без обещания coverage или fault.

**Приемка:** никаких выдуманных urgency, damage, scarcity, approval, warranty или authority; каждое
customer decision допускает управляемую коррекцию через историю.

### UF-08: service case до проверенного remedy и recovery

1. Создать или дедуплицировать service case относительно owned customer, property, job, asset, warranty и consent.
2. Human-authority triage классифицирует safety/containment, urgency, responsibility uncertainty и required visit.
3. Diagnosis записывает attributable evidence и при наличии полномочий выпускает service work package.
4. Field выполняет remedy через обычные safety и evidence controls.
5. Отдельное verification decision подтверждает remedy outcome; customer acceptance записывается независимо.
6. Supplier, manufacturer или insurer recovery создает intent, но не заявленный settlement.
7. Provider execution и readback сверяют recovery либо оставляют durable exception.
8. Reopen сохраняет предыдущую историю и причину.

### UF-09: onboarding tenant и company, затем configuration

1. Owner создает или принимает tenant/company setup с brand, legal entity, geography, service scope, users, roles, devices и integration profile.
2. Система проверяет required authorities и блокирует activation неподдерживаемого scope.
3. Настроить pipelines/stages, schema fields/forms, documents, recipients, automations и role grants как versioned histories.
4. Настроить provider manifests с tenant/provider identity, scopes, directions, actions, idempotency, readback, fallback, proof TTL и secret references вне user-visible data.
5. Выполнить readiness checks и non-customer reference journey.
6. Активировать только capabilities, чьи configuration и proof gates прошли; остальные оставить явно disabled.
7. Export, restore, rollback и second-tenant isolation должны быть доказаны до заявления о reusable Operating Packs или white-label maturity.

### UF-10: управляемое AI-предложение до проверенного эффекта

1. Роль задает одну ограниченную цель.
2. Context builder предоставляет tenant/job-scoped snapshot со stable IDs, versions, source hashes, trust class, observed/effective time и freshness deadlines.
3. Модель вычисляет или предлагает registered actions с citations, preconditions, expected result, risk, stop condition и ceilings.
4. Deterministic validator отклоняет unknown actions, missing/stale/conflicting facts, absent policy или exhausted ceilings.
5. Policy engine возвращает allow, deny или required human role; permit связывает exact action input.
6. Coordinator исполняет только permitted internal или external action через registered adapter.
7. Readback и reconciliation проверяют material result.
8. Audit записывает terminal outcome; no-progress, ambiguity или conflict становятся exception.

### UF-11: сбой интеграции и восстановление

1. Adapter записывает requested effect с correlation и idempotency identity до отправки.
2. При transport failure до исполнения retry возможен только в пределах registered bounded policy.
3. При timeout или unknown outcome система останавливает автоматическое дублирование и запрашивает provider readback.
4. Если deterministic matching успешен, выполняется reconciliation; если он опровергает success, возможны compensation или retry по policy; если результат остается ambiguous, назначается manual exception.
5. Degraded product surfaces показывают недоступную capability и safe fallback, сохраняя owned operation.
6. Recovery перестраивает projections из owned truth и воспроизводит только duplicate-safe pending work.

## 9. Модель возможностей

### 9.1 Постоянные операционные функции

Каждая функция требует accountable role, canonical objects, SOP, authority, evidence, controls,
KPI, retention rule и exception path.

| Группа | Постоянные функции |
|---|---|
| Управление | 1 Ownership and governance; 2 Legal/licence/compliance administration; 3 Market, brand and claims |
| Получение работы | 4 Lead intake and communication; 5 Qualification and sales; 6 Property, inspection and measurement; 7 System design; 8 Estimating and pricing; 9 Proposal, contract and customer decision |
| Подготовка | 10 Preconstruction; 11 Supplier and procurement; 12 Inventory and warehouse; 13 Shop manufacturing; 14 Production planning and dispatch |
| Выполнение | 15 Human field work; 16 Safety; 17 Quality; 18 Change, delay, incident and dispute; 19 Completion and closeout |
| Поддержка | 20 Warranty, service and customer success; 21 Finance, accounting, tax and cash; 22 People and subcontractors; 23 Fleet, equipment and facility |
| Контроль | 24 Data, software, privacy, security and continuity; 25 Insurance, legal claims and continuity; 26 Performance and improvement |

### 9.2 Инвентарь возможностей продукта и зрелость

| Возможность | Пользовательский результат | Состояние снимка | Обязательное доказательство закрытия |
|---|---|---|---|
| Identity, session, role navigation, device pairing | Правильный актер попадает в ограниченную поверхность | Реализовано в коде | Deployed tenant isolation, revocation, recovery и real-device proof |
| Now, Today, approvals, exceptions, search | Каждая роль видит приоритетную допустимую работу | Реализовано в коде; search уже существует, несмотря на старую формулировку matrix | Runtime permission, staleness и exception-resolution scenarios |
| Intake, lead triage, customer/property/job conversion | Один owned demand thread без duplicate provider identity | Сильная реализация в коде | Real dual-brand intake, import reconciliation, bridge retirement |
| Survey, measurement, Facet evidence | Атрибутированные geometry/design inputs и uncertainty | Частично | Real-site calibration, conflicting-source tests, configured Facet delivery |
| Estimate, quote, revisions, proposal publication | Точная проверяемая коммерческая опция | Частично, сильный source path | Configured template/delivery/tax/readback и deterministic reference journey |
| Customer acceptance и deposit derivation | Точное решение создает правильный financial intent | Реализовано в коде, provider proof открыт | Identity/revision scenarios плюс QuickBooks sandbox/readback |
| Production gates и derived phase | Readiness объяснима и не обходится | Сильная реализация в коде | Live issuer freshness, stale/conflict injection, решение по phase vocabulary |
| Assignments и work packages | Field получает точные текущие полномочия | Сильная реализация в коде | Multi-worker и real-device offline full-day proof |
| Safety | Stops, incidents, readiness и corrective action остаются authoritative | Сильная реализация в коде | Real-device drill и live reporting/readback там, где требуется |
| Quality, change, closeout | Работа и deviations закрываются независимыми доказательствами | Частично | Defect/hold/change propagation и real closeout/recovery |
| Inventory, warehouse, procurement | Материалы и custody сохраняются через работу | Частично | Receiving PWA, supplier transmission, AP adapter, live reconciliation |
| Shop manufacturing | Controlled release, QC, yield и bundle handover | Частично | Physical event capture, tooling/maintenance, dispatch и billing proof |
| Scheduling/dispatch | Conflict-free assignment из текущих фактов | Частично | Capacity/weather/material inputs и dispatcher acceptance |
| Fleet/equipment/cargo | Unsafe или wrong-custody assets нельзя выпустить | Частично, mobile route реализован | Photo evidence, telematics identity, collision lifecycle, real vehicle day |
| Accounting и QuickBooks | Approved intent становится provider-posted reconciled truth | Частично, execution/config proof открыт | OAuth, mapping/tax, sandbox effect/readback, accountant signoff |
| Service/warranty/recovery | Complaint превращается в attributable verified remedy | Сильный частичный lifecycle | Dispatch/portal/mobile integration, provider recovery settlement |
| Customer portal/public estimator | Клиент безопасно принимает решение и самообслуживается | Частично, поверхности в коде | Accessibility, identity, real customer scenarios, public config proof |
| Pipeline/form/document configuration | Операционные views меняются без обхода authority | Частично | Merged UI, typed command proof, runtime document generation/readback |
| Provider manifests и readiness | Capabilities ломаются явно и безопасно | Частично | Named-environment dependency health, proof TTL, degraded/recovery drills |
| Hermes/MCP/AI coordination | Bounded drafting и proposals уменьшают routine work | Default-off narrow pilot, целевое состояние | Deterministic reference journey до model-assisted trials |
| Frappe compatibility и retirement | Legacy projection не возвращает себе authority | Retirement in progress | Consumer inventory, parity/cutover proof, restore/rebuild, disabled writes |
| White label / Operating Packs | Повторяемая безопасная настройка tenant без drift | Частично, целевое состояние | Second real tenant, isolation, upgrade/rollback compatibility |
| Governance, workforce, facility, insurance, compliance | Whole-company controls соединяются с operating facts | В основном target или partial | Owning objects, issuer readbacks, drills, accountable signoffs |

### 9.3 Текущие флаги возможностей из проверенного снимка архитектуры

Архитектурный документ фиксирует reference configuration с включенным effect runtime, но с
выключенными или отсутствующими QuickBooks OAuth/final-invoice execution, Hermes desktop, public
estimator, Newo, Postiz, Facet routes и proposal-template configuration. Это факты снимка
документации, а не live readback среды. UI обязан честно показывать недоступные возможности.

## 10. Функциональные требования

### 10.1 Управляющее ядро

- **FR-CTL-001:** Каждый изменяемый aggregate имеет owned tenant ID, stable ID, version, state machine, immutable events и retention class.
- **FR-CTL-002:** Каждый transition проверяет expected version/state, authenticated actor, точное permission на действие, required inputs, evidence и freshness, policy version, hard stops и idempotency.
- **FR-CTL-003:** State и audit event фиксируются атомарно либо переходят в именованное partial-failure state.
- **FR-CTL-004:** Corrections добавляются или supersede историю; обычные пользователи и agents не переписывают прошлое.
- **FR-CTL-005:** Все denials возвращают stable reason codes и безопасный понятный путь разрешения.
- **FR-CTL-006:** Tenant isolation действует на границах storage, query, object, cache, queue, effect, evidence и provider mapping.
- **FR-CTL-007:** Shared accounts и unattributed effects отклоняются.

### 10.2 Доказательства и документы

- **FR-EVD-001:** Evidence поддерживает классы `source`, `derived`, `physical`, `authority`, `financial`, `decision` и `negative` с class-specific integrity metadata.
- **FR-EVD-002:** Raw evidence bytes неизменяемо хранятся в R2 или через authenticated external reference; D1 хранит identity, hashes, binding, version и lifecycle metadata.
- **FR-EVD-003:** Evidence freshness включает issuer, subject/scope, effective/expiry, revocation, recheck, clock tolerance, retention и access class.
- **FR-EVD-004:** Conflicting sources разрешаются по точным authority, scope, time и integrity либо создают blocking exception; система не усредняет и не выбирает удобный источник.
- **FR-EVD-005:** Generated documents связывают template/version, schema values, source facts, actor, digest, object key, effect/readback и terminal receipt.
- **FR-EVD-006:** Missing или ambiguous document/effect readback не может создать duplicate object или false completion.

### 10.3 Внешние эффекты и интеграции

- **FR-EFX-001:** Каждое external action использует registered action kind и versioned integration manifest с точными provider/tenant identity, scopes, direction, data class, retry, readback, reconciliation, fallback, readiness и proof TTL.
- **FR-EFX-002:** Effect ledger записывает requested, permitted, attempted, acknowledged, read back, reconciled, compensated, rejected, not-executed, ambiguous и manual-exception outcomes.
- **FR-EFX-003:** Provider credentials недоступны моделям и обычному browser code.
- **FR-EFX-004:** Webhook receipt или transport success является evidence, но не business completion.
- **FR-EFX-005:** Retries ограничены и duplicate-safe; unknown outcome требует readback до следующей consequential попытки.
- **FR-EFX-006:** Readiness является dependency-specific и видима пользователю; здоровье одного провайдера не маскирует сбой другой обязательной зависимости.

### 10.4 Коммерческий контур и решение клиента

- **FR-COM-001:** Quote, proposal, publication, acceptance, cancellation и change являются immutable revision chains с точными cross-references.
- **FR-COM-002:** Published customer content строится только из approved current facts и controlled templates/claims.
- **FR-COM-003:** Customer acceptance проверяет identity и authority и связывает exact displayed revision и content digest.
- **FR-COM-004:** Acceptance выводит deposit intent через policy и не может утверждать payment или posting.
- **FR-COM-005:** Scope, price, assumptions, exclusions, tax, cancellation, warranty и change consequences видимы в момент решения.
- **FR-COM-006:** Customer correction, complaint, appeal и immediate person paths сохраняются.

### 10.5 Production, field, safety и quality

- **FR-OPS-001:** Production gates являются независимыми versioned facts с точными evidence и freshness.
- **FR-OPS-002:** Assignments добавляются или supersede и отклоняют crew, capacity, custody, predecessor или version conflicts.
- **FR-OPS-003:** Work packages связывают scope, location, versions, actors, instructions, hazards, evidence slots, hold points, stop conditions, emergency contacts и expiry.
- **FR-OPS-004:** Worker acknowledgement привязан к actor, device и package version.
- **FR-OPS-005:** Start проверяет все current holds online; offline cache не может создать release.
- **FR-OPS-006:** Stop-work всегда доступен, немедленен, долговечен и не может быть отменен schedule, margin, AI или обычным approval.
- **FR-OPS-007:** Completion требует declared evidence и независимых hold/quality decisions; message, отдельная photo или mutable status недостаточны.
- **FR-OPS-008:** Material, custody, yield, change, incident, deficiency и closeout facts сверяются между физическими и финансовыми количествами.

### 10.6 Финансы и бухгалтерия

- **FR-FIN-001:** Accounting actions начинаются как owned intents, выведенные из authoritative commercial или completion facts.
- **FR-FIN-002:** QuickBooks остается posted accounting truth; IronWrap владеет intent, policy, mapping, effect, readback, mirror, reconciliation и exception.
- **FR-FIN-003:** Provider detail readback должен совпасть по entity, amount, currency, tax, document identity и source intent до reconciliation.
- **FR-FIN-004:** Payment, refund, credit, holdback, payroll, tax и filing capabilities остаются disabled до одобрения и доказательства их точной policy и posting target.
- **FR-FIN-005:** Segregation of duties не позволяет одному актеру создавать sensitive master data, выпускать effect и независимо закрывать audit finding там, где policy требует разделения.

### 10.7 Конфигурация и администрирование

- **FR-CFG-001:** Изменения company, role, device, pipeline, stage, field, form, template, recipient, automation, provider и operating profile являются versioned и attributable.
- **FR-CFG-002:** Pipeline cards являются read models над domain facts; drag/drop преобразуется в registered versioned command и сохраняет gate blockers.
- **FR-CFG-003:** Field definitions объявляют type, validation, sensitivity, authority, evidence, offline behavior, correction и retention.
- **FR-CFG-004:** Activation требует validation, preview или dry run там, где возможно, rollback path и traceability затронутых поверхностей.
- **FR-CFG-005:** Exports не содержат plaintext secrets; imports проверяются, ограничиваются tenant и совместимы с upgrade/rollback.

### 10.8 AI и автоматизация

- **FR-AI-001:** Модели могут только observe, derive и propose; deterministic code владеет policy, permits, transitions, effects, readback и reconciliation.
- **FR-AI-002:** Context snapshots маркируют untrusted text как data и включают stable fact citations, versions, trust, time и freshness.
- **FR-AI-003:** Plan proposals объявляют одну goal, bounded steps, registered actions, citations, preconditions, risk, expected result, stop condition, reviewer class и ceilings.
- **FR-AI-004:** Unknown actions, missing citations, stale/conflicting facts, absent policy и exhausted ceilings приводят к abstention и durable exception.
- **FR-AI-005:** Agent-to-agent coordination использует canonical objects/events, а не unbounded peer chat.
- **FR-AI-006:** Agent, tool, model и policy versions записываются для каждого consequential proposal и audited outcome.

## 11. Модель домена и состояний

### 11.1 Семейства канонических объектов

| Семейство | Представительные объекты |
|---|---|
| Identity и governance | tenant, brand, legal entity, owner, delegation, authority, policy, licence, permit |
| Relationships | person, organization, customer, property, contact point, consent, suppression |
| Demand и commercial | lead, opportunity, appointment, survey, measurement, design, option, estimate, quote, proposal/publication, contract, acceptance, cancellation, change |
| Product и supply | controlled product, assembly, manufacturer document, supplier, catalog snapshot, supplier quote, purchase order, receipt, credit, recall |
| Inventory и shop | item, lot, coil/sheet, bin/location, reservation, remnant, scrap, count, work centre, machine, tooling, calibration, route, operation, first piece, NCR, bundle |
| People и assets | employee, subcontractor, competency, credential, apprenticeship, training, WCB, assignment, vehicle, trailer, equipment, inspection, maintenance, incident, custody |
| Delivery | roof job, gate, schedule, work package, field event, hazard, hold point, evidence, completion |
| Finance | intent, invoice, holdback, payment, refund, payroll, tax filing, provider mirror, reconciliation |
| Aftercare | warranty declaration, service case, complaint, remedy, review request, recovery intent |
| Platform и assurance | workflow view, pipeline, form/schema, template, integration manifest, operating profile/pack, audit finding, risk, exception, corrective action, recovery test |

### 11.2 Независимые авторитетные жизненные циклы

1. Lead: `captured → triaged → qualified | disqualified → converted`.
2. Measurement, design, quote, proposal, publication и acceptance: immutable revision chains.
3. Production gates: отдельный lifecycle на каждый required gate с freshness и revocation.
4. Assignment: append-only revisions и supersession.
5. Work package: `Draft → Released → Acknowledged → In Progress → Blocked | Completed | Superseded`.
6. Safety: report, stop, rescue, make-safe, corrective action и independent release.
7. Accounting: intent, approval, execution, readback, reconciliation и exception.
8. Closeout, warranty и service: completion packet, warranty facts, service diagnosis/remedy/verification, customer decision, recovery reconciliation и reopen history.

### 11.3 Производная фаза работы

`job_phase` является read-only projection. Текущий исполняемый код определяет:

`cancelled`, `qualification_pending`, `qualified`, `commercial_in_progress`, `deposit_pending`,
`production_blocked`, `safety_blocked`, `production_ready`, `scheduled`, `in_progress`,
`substantially_complete` и `financially_closed`.

Канонический операционный документ также описывает отдельную фазу `contracted`. Текущий
`derivePhase` ее не выдает; accepted work без reconciled deposit сразу получает
`deposit_pending`. Владельцы продукта и архитектуры должны либо выровнять канонический словарь,
либо добавить отсутствующий derived predicate до использования phase names как стабильного
external contract. Ни одна command не может использовать projection как источник полномочий.

## 12. Системная архитектура

### 12.1 Текущая целевая топология

- **PWA:** role и customer interaction, offline cache/outbox, typed commands и read models.
- **Worker application API:** authentication, tenant/role checks, validation, policies, transitions, effects, provider adapters, reconciliation и read models.
- **D1:** owned operating aggregates, immutable transitions, effects, receipts, configuration и projections для deterministic reads.
- **R2:** immutable raw evidence и generated controlled objects; D1 хранит bindings и digests.
- **QuickBooks:** posted accounting truth, доступная через bounded accounting intents и readback.
- **Facet:** отдельный project/design authority, который может передавать attributable design evidence в IronWrap roof job; он не владеет quote, contract, deposit, schedule, invoice или accounting truth.
- **Frappe:** временная compatibility projection, планируемая к evidence-backed retirement; она не должна снова получить writes или authority.
- **Google Drive:** human-readable controlled archive при наличии конфигурации, но не operating database.
- **Email/SMS/voice, Postiz, Newo, JobNimbus/imports, suppliers и authorities:** bounded adapters или sources под manifests, identity mapping, idempotency, readback и retirement rules.
- **Hermes/MCP:** bounded read, dry-run и proposal adapters плюс default-off narrow drafting pilot; никогда не resident operating authority.

### 12.2 Границы доверия

| Граница | Обязательный контроль |
|---|---|
| Browser → Worker | Authenticated session, CSRF/origin controls при необходимости, tenant/role permission, validation, expected version, idempotency |
| Worker → D1 | Prepared и scoped access, atomic transition плюс audit, никаких tenantless mutation |
| Worker → R2 | Content hash, tenant/aggregate binding, immutable key, controlled access/retention |
| Worker → provider | Registered adapter, secret isolation, exact permit, bounded retry, provider identity, readback/reconciliation |
| Facet → IronWrap | Signed attributable evidence delivery, project/job mapping, version/hash, acceptance/refusal; никаких commercial mutation |
| Frappe ↔ IronWrap | Только D1-to-projection для разрешенных compatibility data; rebuildable и non-authoritative |
| AI → control kernel | Bounded context/proposal schema; никаких raw credentials, generic SQL, provider mutation или inferred permit |
| Offline device → Worker | Paired identity, signed/ordered queue item, allowed offline action class, replay idempotency, version/conflict checks |

### 12.3 Соглашения поведения API

- Versioned `/api/v1` contracts, stable machine reason codes и structured validation errors.
- Tenant и actor context выводятся из authenticated server state, а не доверенных request fields.
- Mutations требуют exact aggregate version или другой explicit precondition.
- `Idempotency-Key` либо эквивалент обязателен для retryable consequential commands.
- Read models включают generation time и stale reasons при неполных фактах.
- External-effect endpoints возвращают requested, pending или exception state и не заявляют provider completion до readback.
- Pagination, filtering и search остаются permission-scoped и bounded.
- Logs и telemetry несут correlation IDs, но редактируют secrets и protected content.

## 13. Offline, деградированный и аварийный режим

- Кэшировать только последний valid assignment/work package, hazard plan, emergency contacts и обязательные reference data для authenticated worker/device.
- Для каждого действия объявить online-only, offline-capturable или emergency-safe; по умолчанию online-only.
- Разрешить offline evidence capture, bounded progress facts, stop и emergency stabilization в пределах owning policy.
- Запретить новые consequential starts, releases, approvals, customer decisions, accounting effects, inventory assumptions и provider claims, пока authority нельзя проверить.
- Сохранять queue order, actor/device identity, local time и server receipt time, payload digest и stable idempotency identity.
- Reconnect выполняет authentication, revocation/freshness, version и conflict checks до commit каждого item.
- Показывать partial replay и manual exception; не удалять и молча не перезаписывать field evidence.
- Recovery должен восстанавливать D1, evidence, identity и configuration в isolated target и перестраивать compatibility projections без придания им authority.

## 14. Требования безопасности, privacy и compliance

### 14.1 Безопасность и privacy

- Least privilege по actor, role, tenant, job, customer, amount, geography, time, device, data class и operation.
- Strong session lifecycle, device pairing/revocation, credential rotation, secret isolation и auditable privilege changes.
- Input validation и output encoding на каждой trust boundary; безопасная обработка file type, size и content.
- Encryption in transit и at rest средствами платформы; никаких secrets в exports, logs, prompts, evidence metadata или client bundles.
- Data inventory, purpose/consent, retention, legal hold, access, correction, export, destruction, breach и recovery для каждого sensitive object class.
- Model context minimization и prompt-injection isolation: connector, document и message text является data, но не instruction.
- Independent audit findings требуют отдельного verifier там, где originating actor не может закрыть собственную finding.

### 14.2 Домены compliance

Продукт должен поддерживать, но никогда самостоятельно не выдавать следующие семейства controls:

- Edmonton и Alberta business, facility, municipal, permit, code и inspection authority;
- residential consumer contracting, disclosures, cancellation и direct/prepaid-sales triggers;
- Alberta OHS, stop-work, incidents, training, rescue, fall protection и COR evidence;
- WCB accounts, subcontractor clearance, worker/subcontractor status и rechecks;
- trade competency, restricted activities, apprentices, supervisors и manufacturer requirements;
- employment, accommodation, payroll, time, records, protected decisions и human review;
- prompt payment, proper invoice, holdback, lien, change, dispute и billing control;
- GST/tax, accounting, T5018, payroll, filing calendars, reconciliation и record retention;
- privacy, recordings, access, cybersecurity, breach, retention и destruction;
- CASL, DNCL, channel, purpose, timing consent и suppression;
- advertising, reviews, warranty, damage, price, scarcity, approval и performance claims;
- asbestos и hazardous material, waste, recycling, environmental и disposal authority;
- fleet, driver, carrier, inspection, cargo, custody, collision и maintenance;
- insurance policies, certificates, limits/exclusions, claims, notification, recovery и warranty.

Владельцы legal и compliance обязаны преобразовать исследованные триггеры в одобренные policy и
evidence rules. Software не должно выводить юридические заключения из этой спецификации.

## 15. Требования доступности и контента

- Цель WCAG 2.2 AA для authenticated и customer-facing web surfaces.
- Полная работа с keyboard, visible focus, semantic landmarks и headings, programmatic names, сдержанные live regions, связь ошибок и возврат focus для dialogs.
- Touch targets и mobile layouts, подходящие для field use и перчаток, где это практично; status не кодируется только цветом.
- Reduced-motion support; safety-critical meaning не зависит от animation.
- Plain-language blocking reasons со stable technical reason code для support.
- Estimates, quotes, contracts, invoices, receipts, warranties и service decisions имеют разные labels и content models.
- Customer или worker language и accessibility preferences являются facts, а не free-text assumptions.
- Evidence capture объясняет purpose, required view/quality, privacy implications и correction path до submission.

## 16. Нефункциональные требования

| ID | Требование | Доказательство приемки |
|---|---|---|
| NFR-REL-001 | Consequential mutations идемпотентны и восстанавливаются в именованный outcome. | Duplicate, timeout, partial-failure и replay tests. |
| NFR-REL-002 | Read models показывают stale/missing dependencies вместо optimistic progress. | Stale evidence и unavailable-provider scenarios. |
| NFR-DUR-001 | Immutable evidence, transitions, effects и receipts переживают restore. | Isolated restore плюс hash/reconstruction verification. |
| NFR-SEC-001 | Tenant, role и object isolation deny-by-default. | Cross-tenant и horizontal/vertical privilege tests. |
| NFR-SEC-002 | Secrets и protected data исключены из prompts, logs, client bundles, exports и receipts. | Static/runtime redaction tests и review. |
| NFR-OFF-001 | Field-safe cached data и allowed queue actions работают на supported real devices. | Full offline job/day exercise. |
| NFR-A11Y-001 | Critical role и customer journeys соответствуют WCAG 2.2 AA. | Automated checks плюс keyboard, screen-reader и manual review. |
| NFR-OBS-001 | Requests, transitions, effects и readbacks используют общие correlation IDs и stable reason codes. | Trace reconstruction одного scenario. |
| NFR-PERF-001 | Performance budgets определены на route, query и evidence operation до release. | Именованные p50/p95/p99 и payload/render budgets с measured results. |
| NFR-BCP-001 | RPO, RTO, outage tolerance, escalation и safe degraded behavior одобрены по capability. | Timed restore и dependency-outage drills. |
| NFR-COMP-001 | Retention, access, destruction и issuer recheck управляются policy по data/evidence class. | Policy tests и sampled audit. |

Числовые цели availability, latency, RPO и RTO намеренно не выдумываются в этом документе.
Владельцы продукта, операций, compliance и стоимости должны одобрить их для каждой именованной
среды до заявления о production readiness.

## 17. Аналитика, telemetry и продуктовые KPI

Метрики помогают людям принимать решения. Они никогда не обходят authority и не становятся
непроверенной оценкой worker или customer.

| Результат | Кандидат на метрику | Обязательные разрезы и защита |
|---|---|---|
| Качество спроса | время ответа на lead, время квалификации, причины qualified/disqualified | brand, channel, geography; проверка consent и fairness |
| Коммерческий поток | measurement-to-quote, quote-to-publication, цикл решения, число revisions | тип работ, полнота evidence; не поощрять скрытый scope |
| Готовность production | время в каждом gate, stale/blocked reasons, причины reschedule | job/work type; safety и authority stops исключены из давления на speed |
| Field execution | acknowledged/start/stop/completion cycle, offline replay outcomes | crew/job/device; запрещен unsafe productivity ranking |
| Безопасность и качество | stops, near misses, hold/NCR/deficiency, время independent closure | severity и recurrence; поощрять сообщения, а не молчание |
| Материалы и цех | точность reservation, shortage, yield/scrap, custody mismatch | item/lot/job/work centre; сохранять measurement uncertainty |
| Финансы | intent-to-post, reconciliation lag, exception/mismatch, cash и AR aging | provider/entity/job; только posted truth |
| Клиент | ясность решения, person escalations, complaints, service reopen, accepted remedy | channel/accessibility/work type; без dark-pattern optimization |
| Надёжность | error/timeout/ambiguous outcomes, queue age, dependency readiness, restore results | environment/provider/action kind |
| AI | abstention, citation failure, policy denial, human edit/acceptance, effect reconciliation | action/risk/model/policy version; никогда не использовать только model confidence |

Для каждой метрики нужны владелец, точное event definition, denominator, freshness, retention,
access, anti-gaming note и baseline до утверждения target.

## 18. Стратегия качества и приёмка

### 18.1 Лестница валидации

1. Pure domain/state/policy tests для deterministic predicates и reason codes.
2. Storage tests для versioning, tenant isolation, atomic event writes, idempotency и migrations.
3. Adapter contract tests для signatures, retries, readback, ambiguity, compensation и redaction.
4. API tests для authentication, permission, validation, conflicts, stale evidence и error shape.
5. PWA component/route tests для role navigation, forms, offline states, focus и plain-language blockers.
6. Integration tests с provider sandboxes или controlled fakes, сохраняющими provider semantics.
7. Real-device упражнения для offline, camera/evidence, pairing/revocation и replay.
8. Dependency/readiness, restore и degraded-operation drills в именованной среде.
9. Контролируемый non-customer reference journey по полному lifecycle.
10. Отдельная accountable customer validation после legal, operational и readiness gates.

### 18.2 Обязательные негативные сценарии

- Cross-tenant identifiers, stale versions, duplicate requests, replayed webhook и revoked device.
- Customer принимает superseded publication или не имеет decision authority.
- Measurement sources конфликтуют или source/evidence hash изменяется.
- Permit, WCB, competency, weather, equipment или evidence истекает после scheduling и до start.
- Valid worker stop при pressure по времени; unauthorized actor пытается выполнить release.
- Offline queue reconnects после supersession assignment или package.
- Provider timeout после possible effect; webhook приходит до или после readback; amount/entity не совпадают.
- Supplier shortage/substitution, inventory unit mismatch, shop defect/yield mismatch и custody gap.
- Hidden condition/change order меняет scope, schedule, material, price и work package.
- Completion packet создан, но final invoice не reconciled; accounting readback есть, но physical completion отсутствует.
- AI получает prompt injection, stale context, missing citations, unsupported action или no-progress loop.
- Backup восстанавливается без projection, с projection drift или с pending effects.

### 18.3 Пакет сквозной приёмки

Capability считается завершённой, только если её пакет называет:

- objective и owning canonical requirement;
- точные source commit, test checkout, CI run и artifact digest;
- configured environment и dependency/readiness readback;
- authenticated actors, roles, tenant, devices, provider accounts и data classification;
- scenario inputs, versions, evidence, policy, transitions, effects, readbacks и reconciliation;
- expected и observed negative/degraded cases;
- accessibility, privacy, security, retention, restore и support evidence;
- accountable business acceptance и, отдельно, customer validation там, где она применима.

## 19. План поставки и gates

Каноническая изменяемая программа остаётся в `CAPABILITY-MATRIX.md`. Команда должна двигаться по
следующим gates, не принимая поздний gate за proof более раннего:

| Gate | Результат | Условие выхода |
|---|---|---|
| 0: документация и authority | Единый словарь и необходимый actor/evidence/effect contract | Docs validation и reviewed authority rules |
| 1: work package и evidence | Точная attributable единица труда | Assignment/package/evidence/offline negative tests |
| 2: people, safety, external authority | Current competency/WCB/permit/stop controls | Freshness/revocation/stop scenarios |
| 3: item, inventory, shop, quality | Сохраняемая физическая истина materials/fabrication | Receive-to-yield/quality/custody reconciliation |
| 4: deterministic commercial closure | Точные quote/publication/acceptance/accounting intents | No-seed reference path через configured provider readback |
| 5: physical и service loops | Completion, closeout, warranty/service и recovery | Realistic field/service scenarios и restore |
| 6: thin governed AI coordinator | Bounded proposals над deterministic controls | Citation/abstention/policy/permit/readback trials |
| 7: configured reference environment | Minimum providers, policies, profiles и readiness | Named-environment manifests и proof TTLs |
| 8: technical production-reference proof | Полный controlled non-customer journey | Exact evidence bundle и accountable review |
| 9: customer validation | Реальный customer journey в approved scope | Отдельная legal, operational и experience acceptance |

### 19.1 Рекомендуемые командные потоки

| Поток | Основная ответственность | Обязательная координация |
|---|---|---|
| Product/operations | Scope, personas, workflows, policies и success measures | Все domain owners, design, engineering и QA |
| Design/content/accessibility | Information architecture, role journeys, forms, decision content, field/customer usability | Product, compliance, frontend и QA |
| Control-plane/backend | Aggregates, policies, transitions, effects, readbacks и projections | Data, integrations, security и domain owners |
| PWA/frontend | Role surfaces, typed commands, offline, evidence capture и accessibility | Backend, design, QA и field operators |
| Data/evidence | D1/R2 schemas, migrations, lineage, retention, restore и analytics | Backend, security, compliance и QA |
| Integrations/accounting | Manifests, mappings, adapters, provider semantics и reconciliation | Accounting, backend, security и QA |
| AI/automation | Context/proposal schemas, evaluation, bounded tools и audit | Backend, security, product и QA |
| Security/privacy/compliance | Threat model, controls, policy mapping, audits, incident и retention | Все workstreams и accountable human authorities |
| QA/release/SRE | Test strategy, environment proof, observability, backup/restore и release receipts | Engineering, product, operations и support |
| Adoption/support | Training, SOPs, migration, support playbooks, business/customer acceptance | Product, operations, design и QA |

## 20. Release, migration и operational readiness

- Release admission связывает authored source, base, exact tested checkout/tree, CI run/attempt/job, migration set,
  artifact и required approvals.
- Concurrency cancellation или сравнение с mutable branch не может сделать старый green run доказательством для new head.
- Migrations forward-controlled, tenant-safe, observable и restore-tested; structural counts остаются под governance capability contract.
- Вывод Frappe требует consumer inventory, D1 parity, cutover/export, rebuild/restore, write disablement и
  post-cutover reconciliation до удаления.
- JobNimbus, temporary CRM и automation bridges требуют owned import mapping, duplicate/conflict handling,
  reconciliation и retirement evidence; без бессрочного dual-write.
- Provider capabilities остаются disabled, пока не пройдут credentials, scopes, mappings, policy, webhook/readback,
  reconciliation, safe fallback и accountable acceptance.
- Runbooks покрывают dependency outage, effect ambiguity, queue backlog, provider revocation, security/privacy incident,
  data restore, field offline day и emergency stabilization.
- Rollback никогда не переписывает committed business history; используются compensation, supersession,
  feature disablement и projection rebuild.

## 21. Риски, решения и явные пробелы

| ID | Вопрос | Текущее следствие | Необходимый владелец или решение |
|---|---|---|---|
| DEC-001 | Каноническая phase `contracted` и current executable vocabulary | External consumers могут связаться с несовместимыми names | Product + architecture: выровнять projector или canonical wording |
| DEC-002 | Holdback и payroll posting target/policy | Related actions намеренно unavailable | Owner + accounting + legal/compliance |
| DEC-003 | QuickBooks provider/tax/mapping/readback configuration | Source route не может доказать financial closure | Accounting + integration owner |
| DEC-004 | Proposal template и delivery provider | Customer publication path не может быть runtime-proven | Sales/product + compliance + integration owner |
| DEC-005 | Facet delivery routes и acceptance contract в environment | Design evidence остаётся externally unconfigured | Facet + IronWrap product/architecture |
| DEC-006 | Порядок retirement для Frappe consumers | Остаётся риск compatibility duplication и drift | Architecture + operations + data |
| DEC-007 | JobNimbus/import bridge cutover | Риск dual-source identity и reconciliation | Operations + data/integrations |
| DEC-008 | Полнота shop, facility, workforce и external authority | Whole-company vision частично остаётся target | Owner + operations + compliance |
| DEC-009 | Активация public estimator, Newo, Postiz и Hermes | Capabilities должны оставаться visibly default-off | Product + security/compliance + channel owner |
| DEC-010 | Числовые SLO/RPO/RTO и support model | Нельзя заявлять production readiness | Owner + SRE/operations + cost owner |
| DEC-011 | Когорта real-customer validation и её authority | Technical proof не заменяет customer proof | Owner + operations + legal/compliance |

Главные системные риски: authority drift, provider ambiguity, duplicate identities/effects,
configuration-presented-as-capability, возврат authority к Frappe или provider projection, stale field evidence,
потеря offline conflicts, privacy leakage в prompts/logs и KPI pressure, которое подавляет safety или честные
exception reports.

## 22. Определение готовности

Story считается done, если:

- названы owning requirement и actor/authority/evidence boundaries;
- реализованы подходящие по риску happy, negative, stale, duplicate, unauthorized, offline/degraded и ambiguous paths;
- учтены schema/migration, API, UI, content, accessibility, telemetry, privacy/retention и support impact;
- прошли focused tests и broader required gates, а unrelated user work не попала в изменение;
- документация и диаграммы обновлены без создания competing authority;
- статусы exact source/test/CI/merge/deploy/runtime/business/customer proof сообщены раздельно;
- provider или physical capability включает readback/reconciliation, а не только request success;
- accountable product/domain owner принял поведение в правильной environment.

Capability считается done только после готовности всех её stories, configuration, dependency readiness,
restore/degraded operation, end-to-end proof и accountable acceptance. Release готов, только когда опубликованы
обязательные artifacts и проверена named environment. Customer validation никогда не выводится из этих статусов.

## 23. Индекс трассируемости

| Вопрос | Основной источник authority | Ключевое implementation evidence в этом snapshot |
|---|---|---|
| Product topology и AI loop | `AI-NATIVE-ARCHITECTURE.md` | `app/src/router.tsx`, `app/src/components/app-shell.tsx`, `workers-bus/src/app-api.ts` |
| Company scope и 26 functions | `AUTONOMOUS-OPERATING-SYSTEM.md` | Domain modules в `workers-bus/src`, role PWA routes |
| Actors, authority, transitions, evidence, effects | `AUTHORITY-AND-EVIDENCE-CONTRACT.md` | D1 migrations, policy/authority/effect/readback modules, offline outbox |
| Current maturity и gates | `CAPABILITY-MATRIX.md` | Current source плюс exact validation receipts; никогда не docs alone |
| Compliance triggers и human signoffs | `COMPLIANCE-REGISTER.md` | Authority records, gates, safety, consent, finance, fleet/service modules |
| PWA roles и routes | Вышестоящие owning contracts | `app/src/lib/roles.ts`, `app/src/router.tsx`, `app/README.md` |
| Derived phase | Architecture/operating contracts | `workers-bus/src/commercial-job-phase.ts` |
| Customer/service surfaces | Authority и capability contracts | portal, contract, estimate и service routes/components |
| Визуальная карта и journeys | Этот синтез подчинён всем источникам выше | `docs/diagrams/ironwrap-os-product-atlas.ru.html` |
| Полный каталог ролей, процессов, интеграций, сценариев и UI-доказательств | Этот синтез подчинён всем источникам выше | `docs/IRONWRAP-OS-OPERATIONS-AND-UI-ANNEX.ru.md` |

## 24. Глоссарий

| Термин | Значение |
|---|---|
| Authority | Проверяемое право выполнить точное действие в заданной области; никогда не model confidence. |
| Evidence | Неизменяемая attributable опора для факта или решения с integrity по классу. |
| Effect | Попытка consequential внутреннего, provider, customer, vendor, legal или physical action. |
| Readback | Independent query или receipt, подтверждающий, что фактически произошло после effect. |
| Reconciliation | Deterministic comparison intent, effect, external result и owned mirror. |
| Permit | Machine-consumable authorization, связывающая action, input, scope, policy, time и limits. |
| Gate | Независимое условие readiness, чьи current evidence должны пройти до release. |
| Projection/read model | Rebuildable view, производное от authoritative facts; оно не independently writable. |
| Work package | Versioned, assigned и acknowledged единица physical work с instructions, evidence, holds и stop controls. |
| Operating profile | Versioned configuration для tenant/environment; не доказательство работы providers. |
| Operating Pack | Reusable configuration только после повторяемого tenant, upgrade, rollback и isolation proof. |
| Technical reference proof | Контролируемый full-system journey, не подразумевающий real customer validation. |
