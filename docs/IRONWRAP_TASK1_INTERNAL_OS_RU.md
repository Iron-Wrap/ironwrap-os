# IronWrap Internal OS

> Историческая справка. Актуальные решения по реализации находятся в
> `final-spec-pack/00-final-decisions.md`, `docs/ACTIVATION-CHECKLIST.md` и
> `SETUP-CHECKLIST.md`.

Этот документ только про внутреннюю систему IronWrap. Он не про внешний SaaS для
metal-layout.

Задача системы простая: убрать хаос между лидами, звонками, JobNimbus, Make,
папками, формами, замерами, proposal, материалами, оплатами и follow-up.

Владелец должен быстро видеть:

- какие лиды пришли;
- кто отвечает за каждый лид;
- где зависли jobs;
- какие proposals ждут клиента;
- где нет deposit или invoice payment;
- какие материалы не готовы;
- какие automations упали;
- кому нужен human follow-up.

## Что уже есть в папке

PDF в repo — это реальные примеры отчетов, которые IronWrap автоматически
получает от RoofRuler на email по конкретным объектам. Это не ручные тестовые
файлы.

Roof reports читаются хорошо. Из них можно вытаскивать площадь крыши, pitch,
facets, eaves, valleys, ridges, rakes, flashing, squares и waste table.

AppliCad XML еще полезнее: там уже есть структурная геометрия — faces, polygons,
pitch, orientation и line types вроде `GABLE`, `FASCIA`, `RIDGE`, `VALLEY`,
`STEP`. Это основной источник для geometry intake.

Siding / gutter / soffit / fascia PDF читаются хуже. Для них нужен review
workflow: OCR или ручная проверка, потом расчет.

## Роли систем

- **GHL** — лиды, формы, звонки/SMS, booking, nurture, reviews и phone AI
  automation.
- **JobNimbus** — главный источник правды по customer, job, property, stage,
  task и job number.
- **Make** — связка между системами, пока хватает текущей логики и volume.
- **Google Drive или OneDrive** — один архив job folders. Не два параллельных
  источника правды.
- **QuickBooks** — accounting: invoices, payments, payment status.
- **NaturalForms** — field forms, work orders, materials request, completion,
  inspection, safety, photos, sketches, signatures, если доступ уже есть.
- **RoofRuler / AppliCad** — measurement package на входе.
- **Renoworks** — подключать только если visualizer реально используется в
  продажах.
- **Paradigm** — подключать только когда material request flow уже стабилен и
  shop/order handoff понятен.

## Рабочий контур

1. Разобрать текущие аккаунты и Make-сценарии.
2. Привести JobNimbus к нормальным stages, fields и job number.
3. Настроить GHL intake, calendar и follow-up.
4. Убрать дубли при `lead -> JobNimbus`.
5. Создавать job folder только после JobNimbus job number.
6. Отправлять NaturalForms output в правильную job folder.
7. Принимать RoofRuler / AppliCad reports как measurement package.
8. Собирать простой proposal/PDF.
9. Показывать QuickBooks status в операционной картине.
10. Сделать owner exceptions view.
11. Проверять workflow на test records.
12. Перед production заменить временные доступы, включить MFA и ограничить роли.

## Телефонный AI

Телефонный AI — это полноценный automation layer для телефонного входа, а не
только missed-call bot.

Он должен покрывать:

- inbound calls;
- missed calls;
- after-hours;
- lead qualification;
- booking;
- CRM updates;
- summaries;
- tasks;
- follow-up;
- escalation.

Что он должен делать:

- собрать имя, телефон, email, адрес, тип работы и срочность;
- отличить roof, siding, gutter, soffit, fascia, commercial, shop/supply;
- book appointment в GHL;
- обновить GHL / JobNimbus там, где lead уже qualified;
- создать summary, task и понятный next step;
- запускать нужный follow-up после звонка;
- отправить сложные случаи человеку: angry customer, warranty, payment dispute,
  legal, insurance, request for human;
- не называть финальную цену;
- не обещать warranty, insurance или financing outcome.

Человек остается в контуре для исключений, спорных ситуаций и решений, где AI
может навредить продажам или liability.

## Что считать готовым

Система готова, когда тестовый job проходит весь путь:

- lead попадает в GHL;
- qualified lead создает или обновляет правильный JobNimbus record;
- duplicate lead не создает duplicate job;
- JobNimbus job number появляется до создания папки;
- folder создается один раз и попадает в правильные ссылки;
- RoofRuler / AppliCad report прикреплен и обработан или отправлен на review;
- proposal/PDF собирается и архивируется;
- QuickBooks status виден в операционной картине;
- NaturalForms output попадает в правильную job folder;
- phone AI создает summary, task, booking или escalation;
- owner видит exceptions без ручного обхода всех систем.
