# Metal Layout Product

Этот документ только про отдельный продукт для рынка. Он не про внутреннюю
автоматизацию IronWrap.

Идея: сделать инструмент для metal roofing / standing seam / metal siding,
который помогает считать панели, cut list, trim, accessories, material request
и передавать заказ в shop или supplier.

## Что важно понять

Фраза “ничего подобного нет” слишком широкая. На рынке уже есть AppliCad, The
EDGE, SmartBuild, HOVER, GAF QuickMeasure, Roofr, RoofSnap, RoofRuler и
ERP-инструменты.

Возможная ниша не в том, чтобы “изобрести первый софт для metal roofing”. Ниша в
более простом workflow для installers и suppliers, которым тяжелые CAD/ERP
системы слишком сложные, дорогие или не ложатся на реальный процесс.

Хорошая формулировка продукта:

> взять existing measurement data, PDF/XML reports или field sketch и превратить
> это в metal-specific panel layout, cut list, trim/accessory list, material
> request, PDF/CSV export и shop/supplier handoff.

## Почему IronWrap подходит для проверки

IronWrap уже получает RoofRuler reports на email. В repo есть реальные примеры
этих PDF. По roof reports можно вытаскивать основные roof metrics: area, pitch,
facets, eaves, valleys, ridges, rakes, flashing, squares и waste table.

Есть AppliCad XML, где геометрия уже структурирована: faces, polygons, pitch,
orientation и line types. Это хороший вход для layout logic.

Есть и слабая сторона: siding / gutter / soffit / fascia PDF читаются хуже. Это
значит, что продукт должен начинаться с review-assisted workflow, а не с обещания
полной автоматизации по всем surface types.

## Что не строить в базовом продукте

- Satellite reconstruction.
- Полноценный 3D visualizer.
- CRM.
- Accounting.
- Marketplace.
- ERP.
- Autonomous pricing.

## MVP

1. Import RoofRuler / AppliCad / Roofr / GAF-style reports.
2. Ручная правка planes, dimensions, pitch и panel direction.
3. Profile settings: panel width, seam type, coil width, gauge, color, trim catalog.
4. Panel schedule.
5. Cut list.
6. Trim/accessory list.
7. Waste/offcut estimate.
8. Material request.
9. PDF/CSV export.
10. Human approval перед заказом материалов.

## Основные пользователи

- Metal roofing installers.
- Siding installers.
- Small exterior contractors.
- Suppliers.
- Rollforming shops.
- Owners, которые сами считают jobs и материалы.

## Что продукт должен выдавать

Для installer:

- понятный panel layout;
- cut list;
- trim/accessory list;
- waste estimate;
- customer/internal PDF.

Для supplier или shop:

- material request;
- profile/color/gauge;
- quantities;
- cut lengths;
- CSV или другой order-friendly export.

Для owner:

- меньше ручного takeoff;
- меньше ошибок в material order;
- понятная связь между measurement report, proposal и material request.

## Проверка спроса

Проверять надо не абстрактный market size, а конкретную боль:

- сколько времени уходит на takeoff;
- сколько ошибок уходит в material order;
- какой waste считается нормальным;
- где installers до сих пор используют бумагу, Excel или ручные sketches;
- кто реально принимает решение о покупке: installer, owner, supplier или shop;
- какой output им нужен: PDF, CSV, quote request, cut list, shop order.

Go/no-go:

- есть реальные jobs/data от IronWrap и внешних contractors;
- есть design partners;
- люди готовы платить или давать рабочие объекты для pilot;
- MVP быстрее или точнее текущего spreadsheet/manual процесса;
- понятно, почему клиент не купит AppliCad, The EDGE или SmartBuild вместо этого.

## Как это связано с внутренней системой IronWrap

Связь только через данные и опыт.

Внутренняя система IronWrap должна дать реальные job examples, reports,
measurement packages, material requests и feedback от команды. Это сырье для
проверки продукта.

Сам metal-layout product должен быть отдельным: отдельный backlog, отдельная
логика, отдельные пользователи, отдельная продажа.

