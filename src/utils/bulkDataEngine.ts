import * as XLSX from 'xlsx';
import {
  Vehicle,
  ECU,
  Connector,
  ConnectorPin,
  FuseBox,
  Fuse,
  Relay,
  WiringDiagram,
  MediaItem,
  PublicationStatus,
  SignalType,
  FuseSupplyType,
  Engine,
  ConnectorCategory
} from '../types';
import { storage } from '../services/storage';
import type { OnlineStorageService } from '../services/onlineStorage';
import { getFuseColor } from './fuseColors';
import { normalizeSearchText } from './searchEngine';

export type BulkEntityType =
  | 'vehicles'
  | 'ecus'
  | 'connectors'
  | 'pins'
  | 'fuseboxes'
  | 'fuses'
  | 'relays'
  | 'images';

export interface ColumnDefinition {
  key: string;
  labelFa: string;
  required: boolean;
  type: 'string' | 'number' | 'status' | 'enum';
  aliases: string[];
  descriptionFa: string;
  example: string;
}

export interface ValidationErrorItem {
  rowIndex: number; // 1-based index (including header)
  columnKey: string;
  columnLabel: string;
  value: unknown;
  messageFa: string;
}

export interface ProbableDuplicateItem {
  rowIndex: number;
  existingId: string;
  existingTitle: string;
  matchReasonFa: string;
  targetData: Record<string, unknown>;
}

export interface MissingDependencyItem {
  rowIndex: number;
  dependentField: string;
  dependentValue: string;
  missingEntityFa: string;
  messageFa: string;
}

export interface ValidationSummary {
  totalRows: number;
  validCount: number;
  invalidCount: number;
  duplicateCount: number;
  missingDependencyCount: number;
  missingRequiredCount: number;
  errors: ValidationErrorItem[];
  duplicates: ProbableDuplicateItem[];
  missingDependencies: MissingDependencyItem[];
  parsedValidRows: Record<string, unknown>[];
}

// Standard Schema definitions according to prompt specifications
export const BULK_SCHEMAS: Record<BulkEntityType, { titleFa: string; columns: ColumnDefinition[] }> = {
  vehicles: {
    titleFa: 'خودروها',
    columns: [
      { key: 'manufacturer', labelFa: 'شرکت سازنده', required: true, type: 'string', aliases: ['سازنده', 'کمپانی', 'برند', 'manufacturer', 'brand', 'company'], descriptionFa: 'نام کمپانی سازنده (مانند ایران خودرو، سایپا)', example: 'ایران خودرو' },
      { key: 'vehicleName', labelFa: 'نام خودرو', required: true, type: 'string', aliases: ['نام خودرو', 'خودرو', 'vehicleName', 'name', 'title', 'car'], descriptionFa: 'نام تجاری و مدل خودرو', example: 'پژو ۲۰۶ تیپ ۵' },
      { key: 'model', labelFa: 'مدل و تیپ', required: false, type: 'string', aliases: ['مدل', 'تیپ', 'نسل', 'model', 'generation', 'trim'], descriptionFa: 'مدل یا نسل خودرو', example: 'تیپ ۵ فرانسه' },
      { key: 'yearFrom', labelFa: 'سال شروع تولید', required: false, type: 'number', aliases: ['سال از', 'از سال', 'yearFrom', 'startYear'], descriptionFa: 'سال شمسی یا میلادی شروع', example: '1385' },
      { key: 'yearTo', labelFa: 'سال پایان تولید', required: false, type: 'number', aliases: ['سال تا', 'تا سال', 'yearTo', 'endYear'], descriptionFa: 'سال پایان تولید', example: '1391' },
      { key: 'engineCode', labelFa: 'کد موتور', required: false, type: 'string', aliases: ['موتور', 'کد موتور', 'engineCode', 'engine'], descriptionFa: 'کد فنی پیشرانه (مانند TU5، XU7، EF7)', example: 'TU5' },
      { key: 'fuelSystem', labelFa: 'سیستم سوخت‌رسانی', required: false, type: 'string', aliases: ['سیستم سوخت', 'سوخت رسانی', 'fuelSystem', 'fuel'], descriptionFa: 'نوع سیستم پاشش و انژکتور', example: 'انژکتوری چندنقطه‌ای بوش' },
      { key: 'ecuIds', labelFa: 'شناسه ECUها', required: false, type: 'string', aliases: ['ای سی یو', 'ecuIds', 'ecus', 'ecu'], descriptionFa: 'شناسه یا نام کامپیوترها (جدا شده با کاما)', example: 'bosch-me744' },
      { key: 'notes', labelFa: 'توضیحات و نکات فنی', required: false, type: 'string', aliases: ['نکات', 'توضیحات', 'notes', 'description'], descriptionFa: 'یادداشت‌های تکنسین و دیاگ', example: 'سیستم برق مالتی‌پلکس فرانسوی' },
      { key: 'source', labelFa: 'منبع اطلاعات', required: false, type: 'string', aliases: ['منبع', 'source'], descriptionFa: 'مرجع مستندات یا نقشه', example: 'دفترچه رسمی ایساکو' },
      { key: 'verificationStatus', labelFa: 'وضعیت تأیید', required: false, type: 'status', aliases: ['وضعیت', 'وضعیت تایید', 'verificationStatus', 'status'], descriptionFa: 'published | verified | pending | draft', example: 'published' }
    ]
  },
  ecus: {
    titleFa: 'کامپیوترهای خودرو (ECU)',
    columns: [
      { key: 'ecuId', labelFa: 'شناسه ECU', required: false, type: 'string', aliases: ['شناسه ecu', 'کد ecu', 'ecuId', 'id'], descriptionFa: 'شناسه یکتای سیستمی ECU (برای به‌روزرسانی دقیق)', example: 'ecu-bosch-me744' },
      { key: 'vehicleId', labelFa: 'شناسه خودرو مرتبط', required: false, type: 'string', aliases: ['شناسه خودرو', 'خودرو', 'vehicleId', 'vehicle'], descriptionFa: 'شناسه یا نام خودروی میزبان این ECU', example: 'peugeot-206' },
      { key: 'manufacturer', labelFa: 'سازنده ECU', required: true, type: 'string', aliases: ['سازنده', 'برند ecu', 'manufacturer', 'brand'], descriptionFa: 'برند سازنده کنترل‌یونیت (Bosch, Siemens, Valeo)', example: 'Bosch' },
      { key: 'ecuName', labelFa: 'نام مدل ECU', required: true, type: 'string', aliases: ['نام ecu', 'مدل ecu', 'ecuName', 'name', 'model'], descriptionFa: 'مدل تجاری مانند ME 7.4.4', example: 'ME 7.4.4' },
      { key: 'partNumber', labelFa: 'شماره فنی / پارت‌نامبر', required: false, type: 'string', aliases: ['پارت نامبر', 'شماره قطعه', 'partNumber', 'partNo'], descriptionFa: 'شماره سریال یا کد کالا', example: '0261206839' },
      { key: 'hardwareVersion', labelFa: 'نسخه سخت‌افزار', required: false, type: 'string', aliases: ['سخت افزار', 'ورژن سخت افزار', 'hardwareVersion', 'hw'], descriptionFa: 'نسخه برد الکترونیکی', example: 'HW 1.2' },
      { key: 'softwareVersion', labelFa: 'نسخه نرم‌افزار / کالیبراسیون', required: false, type: 'string', aliases: ['نرم افزار', 'ورژن نرم افزار', 'softwareVersion', 'sw'], descriptionFa: 'کد دامپ و نرم‌افزار', example: 'SW 35.8' },
      { key: 'compatibleEngineCodes', labelFa: 'کدهای موتور سازگار', required: false, type: 'string', aliases: ['موتورهای سازگار', 'کد موتور', 'compatibleEngineCodes', 'engines'], descriptionFa: 'کدهای موتور جدا شده با کاما', example: 'TU5JP4, TU5' },
      { key: 'connectorIds', labelFa: 'شناسه سوکت‌ها', required: false, type: 'string', aliases: ['سوکت ها', 'سوکتها', 'connectorIds', 'connectors'], descriptionFa: 'شناسه یا کدهای سوکت متصل', example: 'conn-206-grey, conn-206-brown' },
      { key: 'notes', labelFa: 'نکات فنی', required: false, type: 'string', aliases: ['نکات', 'توضیحات', 'notes', 'description'], descriptionFa: 'نکات پروگرم و دیاگ', example: 'امکان تعریف ریموت والئو' },
      { key: 'source', labelFa: 'منبع', required: false, type: 'string', aliases: ['منبع', 'source'], descriptionFa: 'مرجع رسمی', example: 'مستندات بوش آلمان' },
      { key: 'verificationStatus', labelFa: 'وضعیت تأیید', required: false, type: 'status', aliases: ['وضعیت', 'verificationStatus', 'status'], descriptionFa: 'published | verified | draft', example: 'published' }
    ]
  },
  connectors: {
    titleFa: 'سوکت‌ها و کانکتورها',
    columns: [
      { key: 'connectorId', labelFa: 'شناسه یکتای سوکت', required: false, type: 'string', aliases: ['شناسه', 'کد سوکت', 'connectorId', 'id'], descriptionFa: 'شناسه سیستمی سوکت', example: 'conn-tu5-grey-32' },
      { key: 'ecuId', labelFa: 'شناسه ECU یا خودرو مرتبط', required: false, type: 'string', aliases: ['شناسه ecu', 'شناسه خودرو', 'ecuId', 'vehicleId'], descriptionFa: 'شناسه قطعه بالادستی مرتبط', example: 'bosch-me744' },
      { key: 'connectorName', labelFa: 'نام کامل سوکت', required: true, type: 'string', aliases: ['نام سوکت', 'عنوان', 'connectorName', 'name'], descriptionFa: 'نام توصیفی سوکت', example: 'سوکت ۳۲ پایه خاکستری' },
      { key: 'connectorType', labelFa: 'دسته‌بندی سوکت', required: false, type: 'string', aliases: ['نوع سوکت', 'دسته', 'connectorType', 'category'], descriptionFa: 'ecu | sensor | actuator | fusebox', example: 'ecu' },
      { key: 'pinCount', labelFa: 'تعداد کل پایه‌ها', required: true, type: 'number', aliases: ['تعداد پایه', 'تعداد پین', 'pinCount', 'pins'], descriptionFa: 'ظرفیت عددی پین‌ها', example: '32' },
      { key: 'viewOrientation', labelFa: 'زاویه دید / رنگ پوسته', required: false, type: 'string', aliases: ['زاویه دید', 'رنگ پوسته', 'viewOrientation', 'socketColor'], descriptionFa: 'رنگ پوسته و جهت ضامن', example: 'خاکستری، ضامن بالا' },
      { key: 'notes', labelFa: 'توضیحات و کاربرد', required: false, type: 'string', aliases: ['توضیحات', 'notes'], descriptionFa: 'یادداشت‌های کاربردی سوکت', example: 'سوکت میانی دسته سیم موتور' },
      { key: 'source', labelFa: 'منبع اطلاعات', required: false, type: 'string', aliases: ['منبع', 'source'], descriptionFa: 'نقشه مرجع کارخانه', example: 'نقشه سیم‌کشی پژو' },
      { key: 'verificationStatus', labelFa: 'وضعیت انتشار', required: false, type: 'status', aliases: ['وضعیت', 'verificationStatus', 'status'], descriptionFa: 'published | verified | draft', example: 'published' }
    ]
  },
  pins: {
    titleFa: 'پین‌اوت‌ها و پایه‌ها',
    columns: [
      { key: 'connectorId', labelFa: 'شناسه سوکت مربوطه', required: true, type: 'string', aliases: ['شناسه سوکت', 'سوکت', 'connectorId'], descriptionFa: 'شناسه سوکتی که این پایه در آن قرار دارد', example: 'conn-tu5-grey-32' },
      { key: 'pinNumber', labelFa: 'شماره یا کد پایه', required: true, type: 'string', aliases: ['شماره پایه', 'پایه', 'شماره پین', 'pinNumber', 'pin'], descriptionFa: 'مثلاً A1, B2, 1, 15', example: 'A1' },
      { key: 'wireColor', labelFa: 'رنگ سیم', required: false, type: 'string', aliases: ['رنگ سیم', 'رنگ', 'wireColor', 'color'], descriptionFa: 'رنگ عایق سیم (مثلاً سفید با خط مشکی)', example: 'سفید با خط قرمز' },
      { key: 'pinFunction', labelFa: 'عملکرد الکتریکی پایه', required: true, type: 'string', aliases: ['عملکرد', 'وظیفه', 'شرح پایه', 'pinFunction', 'function'], descriptionFa: 'شرح عملکرد پایه (انژکتور ۱، رله دوبل و...) ', example: 'پالس منفی انژکتور سیلندر ۱' },
      { key: 'signalType', labelFa: 'نوع سیگنال', required: false, type: 'string', aliases: ['سیگنال', 'نوع سیگنال', 'signalType', 'type'], descriptionFa: '12V_BAT, 12V_IGN, 5V_REF, GROUND, PWM_PULSE, ANALOG_IN', example: 'PWM_PULSE' },
      { key: 'voltage', labelFa: 'محدوده ولتاژ کاری', required: false, type: 'string', aliases: ['ولتاژ', 'رنج ولتاژ', 'voltage', 'voltageRange'], descriptionFa: 'مثلاً 12.0V - 14.4V یا 5V', example: '12.0V - 14.4V' },
      { key: 'sensorOrActuator', labelFa: 'سنسور یا عملگر متصل', required: false, type: 'string', aliases: ['سنسور', 'عملگر', 'sensorOrActuator', 'target'], descriptionFa: 'نام قطعه مقصد این سیم', example: 'سوزن انژکتور ۱' },
      { key: 'notes', labelFa: 'راهنمای تست دیاگ', required: false, type: 'string', aliases: ['راهنمای تست', 'نکات', 'notes', 'testGuide'], descriptionFa: 'روش سنجش با مولتی‌متر یا اسیلوسکوپ', example: 'تست پالس با لامپ دیودی' },
      { key: 'source', labelFa: 'منبع مستند', required: false, type: 'string', aliases: ['منبع', 'source'], descriptionFa: 'مرجع نقشه', example: 'نقشه رسمی ایران خودرو' },
      { key: 'verificationStatus', labelFa: 'وضعیت تأیید', required: false, type: 'status', aliases: ['وضعیت', 'verificationStatus', 'status'], descriptionFa: 'published | verified | draft', example: 'published' }
    ]
  },
  fuseboxes: {
    titleFa: 'جعبه‌فیوزها',
    columns: [
      { key: 'vehicleId', labelFa: 'شناسه خودرو مرتبط', required: true, type: 'string', aliases: ['شناسه خودرو', 'خودرو', 'vehicleId'], descriptionFa: 'شناسه خودروی مربوط به این جعبه‌فیوز', example: 'peugeot-206' },
      { key: 'fuseBoxName', labelFa: 'نام جعبه‌فیوز', required: true, type: 'string', aliases: ['نام جعبه فیوز', 'جعبه فیوز', 'fuseBoxName', 'name'], descriptionFa: 'عنوان و مدل جعبه‌فیوز (مانند BM34 یا BSI)', example: 'جعبه‌فیوز محفظه موتور (BM34)' },
      { key: 'location', labelFa: 'محل نصب', required: true, type: 'string', aliases: ['محل نصب', 'موقعیت', 'location'], descriptionFa: 'cabin (اتاق) | engine (موتور) | battery (باتری)', example: 'engine' },
      { key: 'modelYear', labelFa: 'سال‌های ساخت تحت پوشش', required: false, type: 'string', aliases: ['سال ساخت', 'مدل سال', 'modelYear', 'modelYears'], descriptionFa: 'محدوده سال تولید', example: '۱۳۸۵ تا ۱۳۹۱' },
      { key: 'engineCode', labelFa: 'کد موتور مرتبط', required: false, type: 'string', aliases: ['موتور', 'کد موتور', 'engineCode', 'engine'], descriptionFa: 'کد پیشرانه سازگار', example: 'TU5' },
      { key: 'notes', labelFa: 'توضیحات و راهنما', required: false, type: 'string', aliases: ['توضیحات', 'نکات', 'notes'], descriptionFa: 'نکات فنی باز و بست', example: 'دارای رله‌های داخلی لحیم‌شده' },
      { key: 'source', labelFa: 'منبع اطلاعات', required: false, type: 'string', aliases: ['منبع', 'source'], descriptionFa: 'دفترچه رسمی', example: 'دفترچه راهنمای مالک پژو' },
      { key: 'verificationStatus', labelFa: 'وضعیت تأیید', required: false, type: 'status', aliases: ['وضعیت', 'verificationStatus', 'status'], descriptionFa: 'published | verified | draft', example: 'published' }
    ]
  },
  fuses: {
    titleFa: 'فیوزها',
    columns: [
      { key: 'fuseBoxId', labelFa: 'شناسه جعبه‌فیوز مربوطه', required: true, type: 'string', aliases: ['شناسه جعبه فیوز', 'جعبه فیوز', 'fuseBoxId'], descriptionFa: 'شناسه جعبه‌فیوز میزبان', example: 'fb-206-engine' },
      { key: 'fuseNumber', labelFa: 'شماره یا کد فیوز', required: true, type: 'string', aliases: ['شماره فیوز', 'کد فیوز', 'فیوز', 'fuseNumber', 'code', 'fuseId'], descriptionFa: 'کد فنی فیوز (مانند F10, MF2, F15)', example: 'F10' },
      { key: 'amperage', labelFa: 'آمپراژ نامی', required: true, type: 'number', aliases: ['آمپراژ', 'آمپر', 'amperage', 'amps', 'ratingAmps'], descriptionFa: 'جریان مجاز (5, 10, 15, 20, 30...)', example: '15' },
      { key: 'fuseType', labelFa: 'نوع استاندارد فیوز', required: false, type: 'string', aliases: ['نوع فیوز', 'fuseType', 'type'], descriptionFa: 'standard | mini | maxi | micro2 | midi', example: 'standard' },
      { key: 'function', labelFa: 'عملکرد و تجهیز مصرف‌کننده', required: true, type: 'string', aliases: ['عملکرد', 'وظیفه', 'شرح', 'function', 'functionName'], descriptionFa: 'سیستم‌های برقی متصل', example: 'پمپ بنزین و گرمکن سنسور اکسیژن' },
      { key: 'protectedCircuit', labelFa: 'مدار محافظت‌شده و خط تغذیه', required: false, type: 'string', aliases: ['مدار محافظت شده', 'مدار', 'protectedCircuit', 'circuit'], descriptionFa: 'شرح خط مدار (+15 سوئیچ یا +30 دائم)', example: '+15 سوئیچ باز، تغذیه رله پمپ' },
      { key: 'notes', labelFa: 'نکات عیب‌یابی فیوز', required: false, type: 'string', aliases: ['نکات', 'notes', 'testTips'], descriptionFa: 'علائم در صورت سوختن این فیوز', example: 'در صورت سوختن خودرو روشن نمی‌شود' },
      { key: 'source', labelFa: 'منبع', required: false, type: 'string', aliases: ['منبع', 'source'], descriptionFa: 'مرجع رسمی', example: 'نقشه فنی برق خودرو' },
      { key: 'verificationStatus', labelFa: 'وضعیت تأیید', required: false, type: 'status', aliases: ['وضعیت', 'verificationStatus', 'status'], descriptionFa: 'published | verified | draft', example: 'published' }
    ]
  },
  relays: {
    titleFa: 'رله‌ها',
    columns: [
      { key: 'fuseBoxId', labelFa: 'شناسه جعبه‌فیوز مربوطه', required: true, type: 'string', aliases: ['شناسه جعبه فیوز', 'جعبه فیوز', 'fuseBoxId'], descriptionFa: 'شناسه جعبه‌فیوز میزبان', example: 'fb-206-engine' },
      { key: 'relayNumber', labelFa: 'شماره یا کد رله', required: true, type: 'string', aliases: ['شماره رله', 'کد رله', 'relayNumber', 'code'], descriptionFa: 'کد فنی رله (مانند R1 یا رله دوبل)', example: 'R1' },
      { key: 'relayName', labelFa: 'نام و عنوان رله', required: true, type: 'string', aliases: ['نام رله', 'عنوان', 'relayName', 'name'], descriptionFa: 'نام سیستم تحت کنترل رله', example: 'رله دوبل انژکتور و پمپ بنزین' },
      { key: 'contactCurrentRating', labelFa: 'جریان نامی کنتاکت قدرت (آمپر)', required: false, type: 'number', aliases: ['جریان کنتاکت', 'آمپراژ رله', 'contactCurrentRating', 'contactAmps', 'amps'], descriptionFa: 'جریان تحمل پلاتین (مثلاً 30 یا 40 آمپر)', example: '30' },
      { key: 'coilVoltage', labelFa: 'ولتاژ تحریک سیم‌پیچ (بوبین)', required: false, type: 'string', aliases: ['ولتاژ بوبین', 'ولتاژ سیم پیچ', 'coilVoltage'], descriptionFa: 'ولتاژ تحریک (مانند 12V DC)', example: '12V DC' },
      { key: 'function', labelFa: 'عملکرد رله در مدار', required: true, type: 'string', aliases: ['عملکرد', 'وظیفه', 'function', 'functionName'], descriptionFa: 'شرح عملکرد در سیستم برق', example: 'برق‌رسانی به ECU، کوئیل و پمپ سوخت' },
      { key: 'relatedCircuit', labelFa: 'پایه‌های بوبین و کنتاکت قدرت', required: false, type: 'string', aliases: ['مدار مرتبط', 'پایه ها', 'relatedCircuit', 'coilPins', 'contactPins'], descriptionFa: 'شماره پایه‌های بوبین (85 و 86) و کنتاکت (30 و 87)', example: 'بوبین: ۸۵ و ۸۶ | کنتاکت: ۳۰ و ۸۷' },
      { key: 'notes', labelFa: 'نکات تست و عیب‌یابی', required: false, type: 'string', aliases: ['نکات', 'تست', 'notes', 'diagnostics'], descriptionFa: 'مقاومت اهمی بوبین و تست ولتاژی', example: 'اهم بوبین حدود ۷۵ تا ۸۵ اهم' },
      { key: 'source', labelFa: 'منبع', required: false, type: 'string', aliases: ['منبع', 'source'], descriptionFa: 'دفترچه رسمی', example: 'نقشه سیم‌کشی کارخانه' },
      { key: 'verificationStatus', labelFa: 'وضعیت تأیید', required: false, type: 'status', aliases: ['وضعیت', 'verificationStatus', 'status'], descriptionFa: 'published | verified | draft', example: 'published' }
    ]
  },
  images: {
    titleFa: 'تصاویر و نقشه‌ها',
    columns: [
      { key: 'recordId', labelFa: 'شناسه تصویر', required: false, type: 'string', aliases: ['شناسه', 'کد تصویر', 'recordId', 'id'], descriptionFa: 'شناسه یکتای تصویر', example: 'img-fb-206-real' },
      { key: 'vehicleId', labelFa: 'شناسه خودرو مربوطه', required: false, type: 'string', aliases: ['شناسه خودرو', 'خودرو', 'vehicleId'], descriptionFa: 'شناسه خودروی مربوطه', example: 'peugeot-206' },
      { key: 'relatedItemType', labelFa: 'نوع آیتم مرتبط', required: true, type: 'string', aliases: ['نوع آیتم', 'دسته', 'relatedItemType', 'entityType'], descriptionFa: 'vehicle | connector | fusebox | diagram', example: 'fusebox' },
      { key: 'relatedItemId', labelFa: 'شناسه آیتم مرتبط', required: true, type: 'string', aliases: ['شناسه آیتم', 'شناسه والد', 'relatedItemId', 'entityId'], descriptionFa: 'شناسه سوکت، خودرو یا جعبه‌فیوز', example: 'fb-206-engine' },
      { key: 'imageType', labelFa: 'دسته‌بندی نوع تصویر', required: true, type: 'string', aliases: ['نوع تصویر', 'دسته تصویر', 'imageType'], descriptionFa: 'fusebox_real | fusebox_cover | socket_front | wiring_diagram', example: 'fusebox_real' },
      { key: 'title', labelFa: 'عنوان تصویر', required: true, type: 'string', aliases: ['عنوان', 'نام تصویر', 'title', 'name'], descriptionFa: 'عنوان واضح و فنی', example: 'تصویر واقعی جعبه‌فیوز کالسکه روی باتری' },
      { key: 'description', labelFa: 'توضیحات تکمیلی', required: false, type: 'string', aliases: ['توضیحات', 'شرح', 'description'], descriptionFa: 'توضیحات کاربردی تکنسین', example: 'نمای روبروی جعبه‌فیوز پس از برداشتن درپوش' },
      { key: 'source', labelFa: 'منبع یا آدرس عکس', required: false, type: 'string', aliases: ['منبع', 'آدرس تصویر', 'url', 'source', 'fileUrl'], descriptionFa: 'آدرس فایل یا مرجع عکاسی', example: 'عکاسی در تعمیرگاه مرکزی' },
      { key: 'verificationStatus', labelFa: 'وضعیت انتشار', required: false, type: 'status', aliases: ['وضعیت', 'verificationStatus', 'status'], descriptionFa: 'published | verified | draft', example: 'published' }
    ]
  }
};

/**
 * Normalizes Persian/Arabic numerals to standard digits (e.g. ۱۵ -> 15)
 */
export function normalizeNumerals(str: string): string {
  if (!str) return '';
  return str
    .replace(/[۰-۹]/g, d => String.fromCharCode(d.charCodeAt(0) - 1728))
    .replace(/[٠-٩]/g, d => String.fromCharCode(d.charCodeAt(0) - 1584));
}

/**
 * Fuzzy header matcher: Given a raw header string from Excel/CSV,
 * matches it to the best column definition key.
 */
export function matchHeaderToColumn(headerStr: string, schema: { columns: ColumnDefinition[] }): string | null {
  if (!headerStr) return null;
  const cleanHeader = normalizeSearchText(headerStr).toLowerCase().replace(/[^a-z0-9\u0600-\u06FF]/g, '');

  for (const col of schema.columns) {
    // Check direct key match
    if (col.key.toLowerCase() === cleanHeader) return col.key;
    // Check labelFa match
    const cleanLabel = normalizeSearchText(col.labelFa).toLowerCase().replace(/[^a-z0-9\u0600-\u06FF]/g, '');
    if (cleanLabel === cleanHeader || cleanHeader.includes(cleanLabel) || cleanLabel.includes(cleanHeader)) {
      return col.key;
    }
    // Check aliases
    for (const alias of col.aliases) {
      const cleanAlias = normalizeSearchText(alias).toLowerCase().replace(/[^a-z0-9\u0600-\u06FF]/g, '');
      if (cleanAlias === cleanHeader) {
        return col.key;
      }
    }
  }
  return null;
}

/**
 * Reads workbook buffer/file and returns list of sheet names
 */
export async function readWorkbookFile(file: File): Promise<{ workbook: XLSX.WorkBook; sheetNames: string[] }> {
  const data = await file.arrayBuffer();
  const workbook = XLSX.read(data, { type: 'array' });
  return { workbook, sheetNames: workbook.SheetNames };
}

/**
 * Parses raw sheet rows into header array and data rows
 */
export function extractSheetData(workbook: XLSX.WorkBook, sheetName: string): {
  headers: string[];
  rawRows: (string | number | boolean | null)[][];
} {
  const worksheet = workbook.Sheets[sheetName];
  if (!worksheet) return { headers: [], rawRows: [] };

  const jsonData = XLSX.utils.sheet_to_json<(string | number | boolean | null)[]>(worksheet, {
    header: 1,
    defval: ''
  });

  if (!jsonData || jsonData.length === 0) return { headers: [], rawRows: [] };

  // First non-empty row as header
  let headerIndex = 0;
  while (headerIndex < jsonData.length && (!jsonData[headerIndex] || jsonData[headerIndex].every(cell => !cell))) {
    headerIndex++;
  }

  if (headerIndex >= jsonData.length) return { headers: [], rawRows: [] };

  const headers = (jsonData[headerIndex] || []).map(h => (h !== null && h !== undefined ? String(h).trim() : ''));
  const rawRows = jsonData.slice(headerIndex + 1).filter(r => r && r.some(c => c !== null && c !== undefined && String(c).trim() !== ''));

  return { headers, rawRows };
}

function normalizeBulkKey(val: unknown): string {
  return normalizeSearchText(normalizeNumerals(String(val ?? '')).trim()).toLowerCase();
}

export function resolveEcuTargetVehicle(
  row: Record<string, unknown>,
  vehicles: Vehicle[],
  existingEcu?: ECU
): { vehicleId: string | null; reason?: string } {
  const rawVehRef = String(row['vehicleId'] || '').trim();
  if (rawVehRef) {
    const byId = vehicles.find(v => v.id.toLowerCase() === rawVehRef.toLowerCase());
    if (byId) return { vehicleId: byId.id };

    const normRef = normalizeBulkKey(rawVehRef);
    const byName = vehicles.find(
      v => normalizeBulkKey(v.name) === normRef || normalizeBulkKey(v.persianName) === normRef
    );
    if (byName) return { vehicleId: byName.id };

    return {
      vehicleId: null,
      reason: `خودرو با شناسه یا نام «${rawVehRef}» برای اتصال ECU در سیستم یافت نشد.`
    };
  }

  const rawEngineCodes = String(row['compatibleEngineCodes'] || '').trim();
  if (rawEngineCodes) {
    const terms = rawEngineCodes
      .split(/[,،|/]+/)
      .map(s => normalizeBulkKey(s))
      .filter(Boolean);

    if (terms.length > 0) {
      const exactMatched = vehicles.filter(v =>
        (v.engines || []).some(eng => terms.includes(normalizeBulkKey(eng.code)))
      );
      if (exactMatched.length === 1) {
        return { vehicleId: exactMatched[0].id };
      }
      if (exactMatched.length > 1) {
        if (existingEcu && exactMatched.some(v => v.id === existingEcu.vehicleId)) {
          return { vehicleId: existingEcu.vehicleId };
        }
        return {
          vehicleId: null,
          reason: `کد موتور «${rawEngineCodes}» بین چند خودرو مشترک است؛ لطفاً ستون شناسه خودرو (vehicleId) را صریحاً مشخص کنید.`
        };
      }

      const tokenMatched = vehicles.filter(v =>
        (v.engines || []).some(eng => {
          const engTokens = normalizeBulkKey(eng.code).split(/\s+/).filter(Boolean);
          return terms.some(t => engTokens.includes(t));
        })
      );
      if (tokenMatched.length === 1) {
        return { vehicleId: tokenMatched[0].id };
      }
      if (tokenMatched.length > 1) {
        if (existingEcu && tokenMatched.some(v => v.id === existingEcu.vehicleId)) {
          return { vehicleId: existingEcu.vehicleId };
        }
        return {
          vehicleId: null,
          reason: `کد موتور «${rawEngineCodes}» بین چند خودرو مشترک است؛ لطفاً ستون شناسه خودرو (vehicleId) را مشخص کنید.`
        };
      }

      return {
        vehicleId: null,
        reason: `هیچ خودرویی با کد موتور سازگار «${rawEngineCodes}» یافت نشد.`
      };
    }
  }

  if (existingEcu && existingEcu.vehicleId && vehicles.some(v => v.id === existingEcu.vehicleId)) {
    return { vehicleId: existingEcu.vehicleId };
  }

  return {
    vehicleId: null,
    reason: 'برای ثبت ECU جدید باید «شناسه خودرو (vehicleId)» یا «کد موتور سازگار» معتبر مشخص شود.'
  };
}

export function resolveConnectorParents(
  row: Record<string, unknown>,
  vehicles: Vehicle[],
  ecus: ECU[],
  existingConnector?: Connector
): { ecuId?: string; vehicleId: string | null; reason?: string } {
  const rawRef = String(row['ecuId'] || '').trim();
  const rawVehFallback = String(row['vehicleId'] || '').trim();

  if (rawRef) {
    const ecuById = ecus.find(e => e.id.toLowerCase() === rawRef.toLowerCase());
    if (ecuById) {
      if (!ecuById.vehicleId || !vehicles.some(v => v.id === ecuById.vehicleId)) {
        return {
          ecuId: ecuById.id,
          vehicleId: null,
          reason: `خودروی والد (${ecuById.vehicleId || 'نامشخص'}) برای ECU «${ecuById.id}» در سیستم یافت نشد.`
        };
      }
      return { ecuId: ecuById.id, vehicleId: ecuById.vehicleId };
    }

    const normRef = normalizeBulkKey(rawRef);
    const ecuByModel = ecus.filter(
      e =>
        normalizeBulkKey(`${e.brand} ${e.model}`) === normRef ||
        normalizeBulkKey(e.model) === normRef
    );
    if (ecuByModel.length === 1) {
      const matchedEcu = ecuByModel[0];
      if (!matchedEcu.vehicleId || !vehicles.some(v => v.id === matchedEcu.vehicleId)) {
        return {
          ecuId: matchedEcu.id,
          vehicleId: null,
          reason: `خودروی والد برای ECU «${matchedEcu.model}» در سیستم یافت نشد.`
        };
      }
      return { ecuId: matchedEcu.id, vehicleId: matchedEcu.vehicleId };
    }
    if (ecuByModel.length > 1) {
      return {
        ecuId: undefined,
        vehicleId: null,
        reason: `نام ECU «${rawRef}» مبهم است و با بیش از یک رکورد مطابقت دارد؛ لطفاً شناسه دقیق ECU را وارد کنید.`
      };
    }

    const vehById = vehicles.find(v => v.id.toLowerCase() === rawRef.toLowerCase());
    if (vehById) {
      return { ecuId: undefined, vehicleId: vehById.id };
    }
    const vehByName = vehicles.find(
      v => normalizeBulkKey(v.name) === normRef || normalizeBulkKey(v.persianName) === normRef
    );
    if (vehByName) {
      return { ecuId: undefined, vehicleId: vehByName.id };
    }

    return {
      ecuId: undefined,
      vehicleId: null,
      reason: `شناسه ارجاع داده شده «${rawRef}» در پایگاه داده خودروها یا ECUها یافت نشد.`
    };
  }

  if (rawVehFallback) {
    const vehById = vehicles.find(v => v.id.toLowerCase() === rawVehFallback.toLowerCase());
    if (vehById) {
      return { ecuId: undefined, vehicleId: vehById.id };
    }
    const normVeh = normalizeBulkKey(rawVehFallback);
    const vehByName = vehicles.find(
      v => normalizeBulkKey(v.name) === normVeh || normalizeBulkKey(v.persianName) === normVeh
    );
    if (vehByName) {
      return { ecuId: undefined, vehicleId: vehByName.id };
    }
    return {
      ecuId: undefined,
      vehicleId: null,
      reason: `خودرو با شناسه «${rawVehFallback}» یافت نشد.`
    };
  }

  if (existingConnector && existingConnector.vehicleId) {
    return {
      ecuId: existingConnector.ecuId,
      vehicleId: existingConnector.vehicleId
    };
  }

  return {
    ecuId: undefined,
    vehicleId: null,
    reason: 'برای ثبت سوکت جدید باید شناسه ECU یا خودروی مرتبط (ecuId) معتبر مشخص شود.'
  };
}

/**
 * Core validation engine: Validates rows against schema, checks required fields,
 * checks dependent foreign keys, and detects existing-DB + intra-file duplicates.
 */
export function validateBulkData(
  entityType: BulkEntityType,
  headers: string[],
  columnMapping: Record<string, string>, // headerIndex -> columnKey
  rawRows: (string | number | boolean | null)[][]
): ValidationSummary {
  const schema = BULK_SCHEMAS[entityType];
  const errors: ValidationErrorItem[] = [];
  const duplicates: ProbableDuplicateItem[] = [];
  const missingDependencies: MissingDependencyItem[] = [];
  const parsedValidRows: Record<string, unknown>[] = [];
  let missingRequiredCount = 0;

  // Pre-fetch existing database records for duplicate and dependency checks
  const existingVehicles = storage.getVehicles();
  const existingEcus = storage.getECUs();
  const existingConnectors = storage.getConnectors();
  const existingFuseBoxes = storage.getFuseBoxes();
  const existingDiagrams = storage.getWiringDiagrams();
  const existingMediaItems = storage.getMediaItems();

  const vehicleIdSet = new Set(existingVehicles.map(v => v.id.toLowerCase()));
  const ecuIdSet = new Set(existingEcus.map(e => e.id.toLowerCase()));
  const connectorIdSet = new Set(existingConnectors.map(c => c.id.toLowerCase()));
  const fuseBoxIdSet = new Set(existingFuseBoxes.map(f => f.id.toLowerCase()));
  const diagramIdSet = new Set(existingDiagrams.map(d => d.id.toLowerCase()));

  const seenBatchKeys = new Set<string>();

  rawRows.forEach((row, rIdx) => {
    const rowNum = rIdx + 2; // +1 for 0-index, +1 for header
    const rowObj: Record<string, unknown> = {};
    let rowHasError = false;

    // Map cells according to columnMapping
    Object.entries(columnMapping).forEach(([colIdxStr, colKey]) => {
      const colIdx = parseInt(colIdxStr, 10);
      const rawVal = row[colIdx];
      const valStr = rawVal !== null && rawVal !== undefined ? normalizeNumerals(String(rawVal)).trim() : '';
      rowObj[colKey] = valStr;
    });

    // 1. Check Required Fields
    schema.columns.forEach(col => {
      const val = rowObj[col.key];
      const strVal = val !== null && val !== undefined ? String(val).trim() : '';

      if (col.required && (!strVal || strVal === '')) {
        errors.push({
          rowIndex: rowNum,
          columnKey: col.key,
          columnLabel: col.labelFa,
          value: '',
          messageFa: `فیلد الزامی «${col.labelFa}» خالی است.`
        });
        rowHasError = true;
        missingRequiredCount++;
      } else if (strVal !== '') {
        // Type validation
        if (col.type === 'number') {
          const num = Number(strVal);
          if (isNaN(num)) {
            errors.push({
              rowIndex: rowNum,
              columnKey: col.key,
              columnLabel: col.labelFa,
              value: strVal,
              messageFa: `مقدار «${strVal}» در ستون «${col.labelFa}» باید یک عدد معتبر باشد.`
            });
            rowHasError = true;
          } else {
            rowObj[col.key] = num;
          }
        }
      }
    });

    // 2. Entity-specific Validations, Dependency Checks & Duplicate Detection
    if (entityType === 'vehicles') {
      const vName = String(rowObj['vehicleName'] || '').trim();
      const vModel = String(rowObj['model'] || '').trim();
      const batchKey = `${normalizeBulkKey(vName)}::${normalizeBulkKey(vModel)}`;

      const match = existingVehicles.find(v => {
        const nameMatch = normalizeBulkKey(v.name) === normalizeBulkKey(vName);
        return nameMatch && (vModel ? normalizeBulkKey(v.generation).includes(normalizeBulkKey(vModel)) : true);
      });

      if (match) {
        duplicates.push({
          rowIndex: rowNum,
          existingId: match.id,
          existingTitle: match.name,
          matchReasonFa: `خودرو با عنوان «${match.name}» در بانک اطلاعاتی موجود است.`,
          targetData: rowObj
        });
      } else if (vName && seenBatchKeys.has(batchKey)) {
        duplicates.push({
          rowIndex: rowNum,
          existingId: `batch:${batchKey}`,
          existingTitle: vName,
          matchReasonFa: `ردیف تکراری خودرو «${vName}» در همین فایل.`,
          targetData: rowObj
        });
      }

      if (!rowHasError && vName) {
        seenBatchKeys.add(batchKey);
      }
    } else if (entityType === 'ecus') {
      const rawEcuId = String(rowObj['ecuId'] || '').trim();
      const eName = String(rowObj['ecuName'] || '').trim();
      const eBrand = String(rowObj['manufacturer'] || '').trim();

      const matchById = rawEcuId
        ? existingEcus.find(e => e.id.toLowerCase() === rawEcuId.toLowerCase())
        : undefined;

      const preResolved = resolveEcuTargetVehicle(rowObj, existingVehicles, matchById);
      const match =
        matchById ||
        existingEcus.find(
          e =>
            normalizeBulkKey(e.brand) === normalizeBulkKey(eBrand) &&
            normalizeBulkKey(e.model) === normalizeBulkKey(eName) &&
            (!preResolved.vehicleId || e.vehicleId === preResolved.vehicleId)
        );

      const finalTarget = resolveEcuTargetVehicle(rowObj, existingVehicles, match);
      if (!finalTarget.vehicleId) {
        missingDependencies.push({
          rowIndex: rowNum,
          dependentField: String(rowObj['vehicleId'] || '').trim() ? 'vehicleId' : 'compatibleEngineCodes',
          dependentValue: String(rowObj['vehicleId'] || rowObj['compatibleEngineCodes'] || ''),
          missingEntityFa: 'خودرو',
          messageFa: finalTarget.reason || 'خودروی مرتبط برای ECU یافت نشد.'
        });
        rowHasError = true;
      }

      const batchKey = rawEcuId
        ? `id:${rawEcuId.toLowerCase()}`
        : `${normalizeBulkKey(eBrand)}::${normalizeBulkKey(eName)}::${finalTarget.vehicleId || ''}`;

      if (!rowHasError) {
        if (match) {
          duplicates.push({
            rowIndex: rowNum,
            existingId: match.id,
            existingTitle: `${match.brand} ${match.model}`,
            matchReasonFa: `کنترل‌یونیت «${match.brand} ${match.model}» قبلاً ثبت شده است.`,
            targetData: rowObj
          });
        } else if (seenBatchKeys.has(batchKey)) {
          duplicates.push({
            rowIndex: rowNum,
            existingId: `batch:${batchKey}`,
            existingTitle: `${eBrand} ${eName}`.trim(),
            matchReasonFa: `ردیف تکراری ECU «${eBrand} ${eName}» در همین فایل.`,
            targetData: rowObj
          });
        }
        seenBatchKeys.add(batchKey);
      }
    } else if (entityType === 'connectors') {
      const cId = String(rowObj['connectorId'] || '').trim();
      const cName = String(rowObj['connectorName'] || '').trim();

      const matchById = cId
        ? existingConnectors.find(c => c.id.toLowerCase() === cId.toLowerCase())
        : undefined;

      const parentRes = resolveConnectorParents(rowObj, existingVehicles, existingEcus, matchById);
      if (!parentRes.vehicleId) {
        missingDependencies.push({
          rowIndex: rowNum,
          dependentField: 'ecuId',
          dependentValue: String(rowObj['ecuId'] || ''),
          missingEntityFa: 'خودرو یا ECU',
          messageFa: parentRes.reason || 'خودرو یا ECU مرتبط با سوکت یافت نشد.'
        });
        rowHasError = true;
      }

      const match =
        matchById ||
        (parentRes.vehicleId && cName
          ? existingConnectors.find(
              c =>
                normalizeBulkKey(c.name) === normalizeBulkKey(cName) &&
                (c.ecuId || '') === (parentRes.ecuId || '') &&
                (c.vehicleId || '') === parentRes.vehicleId
            )
          : undefined);

      const batchKey = cId
        ? `id:${cId.toLowerCase()}`
        : `name:${normalizeBulkKey(cName)}::${parentRes.ecuId || ''}::${parentRes.vehicleId || ''}`;

      if (!rowHasError) {
        if (match) {
          duplicates.push({
            rowIndex: rowNum,
            existingId: match.id,
            existingTitle: match.name,
            matchReasonFa: `سوکت با شناسه «${match.id}» از قبل در سیستم موجود است.`,
            targetData: rowObj
          });
        } else if (seenBatchKeys.has(batchKey)) {
          duplicates.push({
            rowIndex: rowNum,
            existingId: `batch:${batchKey}`,
            existingTitle: cName || cId,
            matchReasonFa: `ردیف تکراری سوکت «${cName || cId}» در همین فایل.`,
            targetData: rowObj
          });
        }
        seenBatchKeys.add(batchKey);
      }
    } else if (entityType === 'pins') {
      const cId = String(rowObj['connectorId'] || '').trim();
      const pinNum = String(rowObj['pinNumber'] || '').trim();

      if (cId && !connectorIdSet.has(cId.toLowerCase())) {
        missingDependencies.push({
          rowIndex: rowNum,
          dependentField: 'connectorId',
          dependentValue: cId,
          missingEntityFa: 'سوکت',
          messageFa: `سوکت با شناسه «${cId}» برای ثبت پایه در سیستم وجود ندارد.`
        });
        rowHasError = true;
      } else if (cId && pinNum) {
        const conn = existingConnectors.find(c => c.id.toLowerCase() === cId.toLowerCase());
        const batchKey = `${cId.toLowerCase()}::${pinNum.toLowerCase()}`;
        if (conn && conn.pins.some(p => p.pinNumber.toLowerCase() === pinNum.toLowerCase())) {
          duplicates.push({
            rowIndex: rowNum,
            existingId: `${cId}-${pinNum}`,
            existingTitle: `پایه ${pinNum} در ${conn.name}`,
            matchReasonFa: `پایه شماره «${pinNum}» از قبل در سوکت «${conn.name}» ثبت شده است.`,
            targetData: rowObj
          });
        } else if (seenBatchKeys.has(batchKey)) {
          duplicates.push({
            rowIndex: rowNum,
            existingId: `batch:${batchKey}`,
            existingTitle: `پایه ${pinNum}`,
            matchReasonFa: `ردیف تکراری پایه «${pinNum}» در همین فایل.`,
            targetData: rowObj
          });
        }
        if (!rowHasError) seenBatchKeys.add(batchKey);
      }
    } else if (entityType === 'fuseboxes') {
      const vId = String(rowObj['vehicleId'] || '').trim();
      const fbName = String(rowObj['fuseBoxName'] || '').trim();

      if (vId && !vehicleIdSet.has(vId.toLowerCase())) {
        missingDependencies.push({
          rowIndex: rowNum,
          dependentField: 'vehicleId',
          dependentValue: vId,
          missingEntityFa: 'خودرو',
          messageFa: `خودرو با شناسه «${vId}» برای اتصال جعبه‌فیوز یافت نشد.`
        });
        rowHasError = true;
      }

      const batchKey = `${vId.toLowerCase()}::${normalizeBulkKey(fbName)}`;
      const match = existingFuseBoxes.find(
        fb => fb.vehicleId.toLowerCase() === vId.toLowerCase() && normalizeBulkKey(fb.name) === normalizeBulkKey(fbName)
      );

      if (!rowHasError) {
        if (match) {
          duplicates.push({
            rowIndex: rowNum,
            existingId: match.id,
            existingTitle: match.name,
            matchReasonFa: `جعبه‌فیوز «${match.name}» برای این خودرو قبلاً ثبت شده است.`,
            targetData: rowObj
          });
        } else if (seenBatchKeys.has(batchKey)) {
          duplicates.push({
            rowIndex: rowNum,
            existingId: `batch:${batchKey}`,
            existingTitle: fbName,
            matchReasonFa: `ردیف تکراری جعبه‌فیوز «${fbName}» در همین فایل.`,
            targetData: rowObj
          });
        }
        seenBatchKeys.add(batchKey);
      }
    } else if (entityType === 'fuses') {
      const fbId = String(rowObj['fuseBoxId'] || '').trim();
      const fNum = String(rowObj['fuseNumber'] || '').trim();
      const amps = Number(rowObj['amperage']);

      if (fbId && !fuseBoxIdSet.has(fbId.toLowerCase())) {
        missingDependencies.push({
          rowIndex: rowNum,
          dependentField: 'fuseBoxId',
          dependentValue: fbId,
          missingEntityFa: 'جعبه‌فیوز',
          messageFa: `جعبه‌فیوز با شناسه «${fbId}» برای ثبت فیوز یافت نشد.`
        });
        rowHasError = true;
      }

      if (isNaN(amps) || amps <= 0 || amps > 150) {
        errors.push({
          rowIndex: rowNum,
          columnKey: 'amperage',
          columnLabel: 'آمپراژ',
          value: rowObj['amperage'],
          messageFa: `آمپراژ ${rowObj['amperage']} نامعتبر است؛ باید مقداری بین ۱ تا ۱۵۰ آمپر باشد.`
        });
        rowHasError = true;
      }

      if (!rowHasError && fbId && fuseBoxIdSet.has(fbId.toLowerCase())) {
        const fb = existingFuseBoxes.find(f => f.id.toLowerCase() === fbId.toLowerCase());
        const batchKey = `${fbId.toLowerCase()}::${fNum.toLowerCase()}`;
        if (fb && fb.fuses.some(f => f.code.toLowerCase() === fNum.toLowerCase())) {
          duplicates.push({
            rowIndex: rowNum,
            existingId: `${fbId}-${fNum}`,
            existingTitle: `فیوز ${fNum} در ${fb.name}`,
            matchReasonFa: `فیوز با شماره «${fNum}» قبلاً در این جعبه‌فیوز تعریف شده است.`,
            targetData: rowObj
          });
        } else if (seenBatchKeys.has(batchKey)) {
          duplicates.push({
            rowIndex: rowNum,
            existingId: `batch:${batchKey}`,
            existingTitle: `فیوز ${fNum}`,
            matchReasonFa: `ردیف تکراری فیوز «${fNum}» در همین فایل.`,
            targetData: rowObj
          });
        }
        seenBatchKeys.add(batchKey);
      }
    } else if (entityType === 'relays') {
      const fbId = String(rowObj['fuseBoxId'] || '').trim();
      const rNum = String(rowObj['relayNumber'] || '').trim();

      if (fbId && !fuseBoxIdSet.has(fbId.toLowerCase())) {
        missingDependencies.push({
          rowIndex: rowNum,
          dependentField: 'fuseBoxId',
          dependentValue: fbId,
          missingEntityFa: 'جعبه‌فیوز',
          messageFa: `جعبه‌فیوز با شناسه «${fbId}» برای ثبت رله در سیستم وجود ندارد.`
        });
        rowHasError = true;
      }

      if (!rowHasError && fbId && fuseBoxIdSet.has(fbId.toLowerCase())) {
        const fb = existingFuseBoxes.find(f => f.id.toLowerCase() === fbId.toLowerCase());
        const batchKey = `${fbId.toLowerCase()}::${rNum.toLowerCase()}`;
        if (fb && fb.relays.some(r => r.code.toLowerCase() === rNum.toLowerCase())) {
          duplicates.push({
            rowIndex: rowNum,
            existingId: `${fbId}-${rNum}`,
            existingTitle: `رله ${rNum} در ${fb.name}`,
            matchReasonFa: `رله با کد «${rNum}» قبلاً در این جعبه‌فیوز ثبت شده است.`,
            targetData: rowObj
          });
        } else if (seenBatchKeys.has(batchKey)) {
          duplicates.push({
            rowIndex: rowNum,
            existingId: `batch:${batchKey}`,
            existingTitle: `رله ${rNum}`,
            matchReasonFa: `ردیف تکراری رله «${rNum}» در همین فایل.`,
            targetData: rowObj
          });
        }
        seenBatchKeys.add(batchKey);
      }
    } else if (entityType === 'images') {
      const rId = String(rowObj['recordId'] || '').trim();
      const rItemType = String(rowObj['relatedItemType'] || '').trim().toLowerCase();
      const rItemId = String(rowObj['relatedItemId'] || '').trim();
      const vId = String(rowObj['vehicleId'] || '').trim();
      const title = String(rowObj['title'] || '').trim();

      let targetExists = false;
      if (rItemType === 'vehicle') targetExists = vehicleIdSet.has(rItemId.toLowerCase());
      else if (rItemType === 'ecu') targetExists = ecuIdSet.has(rItemId.toLowerCase());
      else if (rItemType === 'connector') targetExists = connectorIdSet.has(rItemId.toLowerCase());
      else if (rItemType === 'fusebox') targetExists = fuseBoxIdSet.has(rItemId.toLowerCase());
      else if (rItemType === 'diagram') targetExists = diagramIdSet.has(rItemId.toLowerCase());
      else if (rItemType === 'pin') targetExists = connectorIdSet.has(rItemId.toLowerCase());

      if (!targetExists) {
        missingDependencies.push({
          rowIndex: rowNum,
          dependentField: 'relatedItemId',
          dependentValue: rItemId,
          missingEntityFa: rItemType || 'موجودیت مرتبط',
          messageFa: `آیتم مرتبط «${rItemId}» از نوع «${rItemType}» در سیستم یافت نشد.`
        });
        rowHasError = true;
      }

      if (vId && !vehicleIdSet.has(vId.toLowerCase())) {
        missingDependencies.push({
          rowIndex: rowNum,
          dependentField: 'vehicleId',
          dependentValue: vId,
          missingEntityFa: 'خودرو',
          messageFa: `خودرو با شناسه «${vId}» در سیستم یافت نشد.`
        });
        rowHasError = true;
      }

      if (!rowHasError) {
        const match = rId
          ? existingMediaItems.find(m => m.id.toLowerCase() === rId.toLowerCase())
          : existingMediaItems.find(
              m =>
                String(m.entityType).toLowerCase() === rItemType &&
                m.entityId.toLowerCase() === rItemId.toLowerCase() &&
                normalizeBulkKey(m.title) === normalizeBulkKey(title)
            );
        const batchKey = rId
          ? `id:${rId.toLowerCase()}`
          : `${rItemType}::${rItemId.toLowerCase()}::${normalizeBulkKey(title)}`;

        if (match) {
          duplicates.push({
            rowIndex: rowNum,
            existingId: match.id,
            existingTitle: match.title,
            matchReasonFa: `تصویر «${match.title}» از قبل در سیستم موجود است.`,
            targetData: rowObj
          });
        } else if (seenBatchKeys.has(batchKey)) {
          duplicates.push({
            rowIndex: rowNum,
            existingId: `batch:${batchKey}`,
            existingTitle: title,
            matchReasonFa: `ردیف تکراری تصویر «${title}» در همین فایل.`,
            targetData: rowObj
          });
        }
        seenBatchKeys.add(batchKey);
      }
    }

    if (!rowHasError) {
      parsedValidRows.push(rowObj);
    }
  });

  return {
    totalRows: rawRows.length,
    validCount: parsedValidRows.length,
    invalidCount: rawRows.length - parsedValidRows.length,
    duplicateCount: duplicates.length,
    missingDependencyCount: missingDependencies.length,
    missingRequiredCount,
    errors,
    duplicates,
    missingDependencies,
    parsedValidRows
  };
}

/**
 * Generates and downloads a pre-formatted template with standard columns and sample row
 */
export function generateBulkTemplate(entityType: BulkEntityType, format: 'xlsx' | 'csv' = 'xlsx'): void {
  const schema = BULK_SCHEMAS[entityType];

  // Headers (English keys for interoperability)
  const headers = schema.columns.map(c => c.key);
  // Sample data row based on examples
  const sampleRow = schema.columns.map(c => c.example);
  // Persian description guide row
  const guideRow = schema.columns.map(c => `${c.labelFa} (${c.required ? 'الزامی' : 'اختیاری'})`);

  const rows = [headers, guideRow, sampleRow];

  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet(rows);
  XLSX.utils.book_append_sheet(wb, ws, schema.titleFa);

  if (format === 'csv') {
    const csvContent = XLSX.utils.sheet_to_csv(ws);
    const blob = new Blob([new Uint8Array([0xEF, 0xBB, 0xBF]), csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `autopin-template-${entityType}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  } else {
    XLSX.writeFile(wb, `autopin-template-${entityType}.xlsx`);
  }
}

/**
 * Generates and downloads an error report in CSV format
 */
export function generateErrorReportCsv(
  entityType: BulkEntityType,
  errors: ValidationErrorItem[],
  duplicates: ProbableDuplicateItem[],
  missingDependencies: MissingDependencyItem[]
): void {
  const rows: (string | number)[][] = [
    ['ردیف', 'نوع گزارش', 'نام فیلد / ستون', 'مقدار ورودی', 'شرح دقیق خطا / تفاوت']
  ];

  errors.forEach(err => {
    rows.push([err.rowIndex, 'خطای داده', err.columnLabel, String(err.value || ''), err.messageFa]);
  });

  duplicates.forEach(dup => {
    rows.push([dup.rowIndex, 'احتمال تکراری', 'شناسه / عنوان', dup.existingTitle, dup.matchReasonFa]);
  });

  missingDependencies.forEach(dep => {
    rows.push([dep.rowIndex, 'ارجاع نامعتبر', dep.dependentField, dep.dependentValue, dep.messageFa]);
  });

  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet(rows);
  const csvContent = XLSX.utils.sheet_to_csv(ws);
  const blob = new Blob([new Uint8Array([0xEF, 0xBB, 0xBF]), csvContent], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `autopin-import-errors-${entityType}-${Date.now()}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

/**
 * Exports database records to CSV or XLSX with custom filters
 */
export function exportDatabaseRecords(
  entityType: BulkEntityType,
  format: 'xlsx' | 'csv' = 'xlsx',
  options?: {
    vehicleId?: string;
    publishedOnly?: boolean;
  }
): { recordCount: number } {
  const schema = BULK_SCHEMAS[entityType];
  let exportRows: Record<string, unknown>[] = [];

  if (entityType === 'vehicles') {
    let list = storage.getVehicles();
    if (options?.publishedOnly) list = list.filter(v => v.status === 'published' || v.status === 'verified');
    exportRows = list.map(v => ({
      manufacturer: v.manufacturerId,
      vehicleName: v.name,
      model: v.generation,
      yearFrom: v.modelYears.split('-')[0]?.trim() || '',
      yearTo: v.modelYears.split('-')[1]?.trim() || '',
      engineCode: v.engines?.map(e => e.code).join(', ') || '',
      fuelSystem: v.electricalSystem,
      ecuIds: v.ecuIds?.join(', ') || '',
      notes: v.description,
      source: v.source || 'AutoPin Pro',
      verificationStatus: v.status || 'published'
    }));
  } else if (entityType === 'ecus') {
    let list = storage.getECUs(options?.vehicleId);
    if (options?.publishedOnly) list = list.filter(e => e.status === 'published' || e.status === 'verified');
    const allVehicles = storage.getVehicles();
    const allConnectors = storage.getConnectors();
    exportRows = list.map(e => {
      const hostVeh = allVehicles.find(v => v.id === e.vehicleId);
      const linkedConns = allConnectors.filter(c => c.ecuId === e.id).map(c => c.id).join(', ');
      return {
        ecuId: e.id,
        vehicleId: e.vehicleId,
        manufacturer: e.brand,
        ecuName: e.model,
        partNumber: e.hardwareVersion || '',
        hardwareVersion: e.hardwareVersion || '',
        softwareVersion: e.softwareVersion || '',
        compatibleEngineCodes: hostVeh?.engines?.map(eng => eng.code).join(', ') || '',
        connectorIds: linkedConns,
        notes: e.description || '',
        source: 'AutoPin Pro',
        verificationStatus: e.status || 'published'
      };
    });
  } else if (entityType === 'connectors') {
    let list = storage.getConnectors(options?.vehicleId);
    if (options?.publishedOnly) list = list.filter(c => c.status === 'published' || c.status === 'verified');
    exportRows = list.map(c => ({
      connectorId: c.id,
      ecuId: c.ecuId || c.vehicleId || '',
      connectorName: c.name,
      connectorType: c.category,
      pinCount: c.pinCount,
      viewOrientation: c.socketColor,
      notes: c.notes || '',
      source: c.source || 'AutoPin Pro',
      verificationStatus: c.status || 'published'
    }));
  } else if (entityType === 'pins') {
    const connectors = storage.getConnectors(options?.vehicleId);
    connectors.forEach(c => {
      c.pins.forEach(p => {
        if (!options?.publishedOnly || p.status === 'published' || p.status === 'verified') {
          exportRows.push({
            connectorId: c.id,
            pinNumber: p.pinNumber,
            wireColor: p.wireColor,
            pinFunction: p.functionName,
            signalType: p.signalType,
            voltage: p.voltageRange,
            sensorOrActuator: '',
            notes: p.testGuide || p.notes || '',
            source: p.source || c.source || 'AutoPin Pro',
            verificationStatus: p.status || 'published'
          });
        }
      });
    });
  } else if (entityType === 'fuseboxes') {
    let list = storage.getFuseBoxes(options?.vehicleId);
    if (options?.publishedOnly) list = list.filter(f => f.status === 'published' || f.status === 'verified');
    exportRows = list.map(fb => ({
      vehicleId: fb.vehicleId,
      fuseBoxName: fb.name,
      location: fb.location,
      modelYear: fb.modelYears || '',
      engineCode: fb.engineCode || '',
      notes: fb.notes || '',
      source: fb.source || 'AutoPin Pro',
      verificationStatus: fb.status || 'published'
    }));
  } else if (entityType === 'fuses') {
    const fbs = storage.getFuseBoxes(options?.vehicleId);
    fbs.forEach(fb => {
      fb.fuses.forEach(f => {
        if (!options?.publishedOnly || f.status === 'published' || f.status === 'verified') {
          exportRows.push({
            fuseBoxId: fb.id,
            fuseNumber: f.code,
            amperage: f.ratingAmps,
            fuseType: f.fuseType || 'standard',
            function: f.functionName,
            protectedCircuit: f.circuitDetails,
            notes: f.testTips || '',
            source: f.source || fb.source || 'AutoPin Pro',
            verificationStatus: f.status || 'published'
          });
        }
      });
    });
  } else if (entityType === 'relays') {
    const fbs = storage.getFuseBoxes(options?.vehicleId);
    fbs.forEach(fb => {
      fb.relays.forEach(r => {
        if (!options?.publishedOnly || r.status === 'published' || r.status === 'verified') {
          exportRows.push({
            fuseBoxId: fb.id,
            relayNumber: r.code,
            relayName: r.name,
            contactCurrentRating: r.contactAmps || 30,
            coilVoltage: r.coilVoltage || '12V DC',
            function: r.functionName,
            relatedCircuit: `${r.coilPins} | ${r.contactPins}`,
            notes: r.diagnostics || '',
            source: r.source || fb.source || 'AutoPin Pro',
            verificationStatus: r.status || 'published'
          });
        }
      });
    });
  } else if (entityType === 'images') {
    let list = storage.getMediaItems();
    if (options?.vehicleId) list = list.filter(m => m.vehicleId === options.vehicleId || m.entityId === options.vehicleId);
    if (options?.publishedOnly) list = list.filter(m => m.status === 'published' || m.status === 'verified');
    exportRows = list.map(m => ({
      recordId: m.id,
      vehicleId: m.vehicleId || '',
      relatedItemType: m.entityType,
      relatedItemId: m.entityId,
      imageType: m.imageType,
      title: m.title,
      description: m.description || '',
      source: m.source || m.fileUrl || '',
      verificationStatus: m.status || 'published'
    }));
  }

  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.json_to_sheet(exportRows, {
    header: schema.columns.map(c => c.key)
  });
  XLSX.utils.book_append_sheet(wb, ws, schema.titleFa);

  const filename = `autopin-${entityType}-export-${new Date().toISOString().slice(0, 10)}`;

  if (format === 'csv') {
    const csvContent = XLSX.utils.sheet_to_csv(ws);
    const blob = new Blob([new Uint8Array([0xEF, 0xBB, 0xBF]), csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${filename}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  } else {
    XLSX.writeFile(wb, `${filename}.xlsx`);
  }

  return { recordCount: exportRows.length };
}

export interface BulkImportCommitOptions {
  entityType: BulkEntityType;
  rows: Record<string, unknown>[];
  duplicateStrategy: 'skip' | 'update';
  isAdmin: boolean;
  isOnlineDbConnected: boolean;
  targetStorage?: typeof storage;
  targetOnlineStorage?: Pick<
    OnlineStorageService,
    'saveVehicle' | 'saveECU' | 'saveConnector' | 'saveFuseBox' | 'saveMedia'
  >;
  onProgress?: (pct: number, statusText: string) => void;
}

export interface BulkImportCommitResult {
  added: number;
  updated: number;
  skipped: number;
  failed: number;
  errors: string[];
}

/**
 * Safely executes bulk import commit with:
 * - true duplicateStrategy ('skip' | 'update') enforcement (both existing DB & intra-batch duplicates)
 * - accurate ECU -> vehicleId and Connector -> (ecuId, vehicleId) parent resolution (no fallback to vehicles[0])
 * - preservation of existing IDs, createdAt, children (engines/pins/fuses/relays), and visual coordinates/grids
 * - cloud-first + pre-row snapshot rollback so failed rows never leave corrupted local state
 */
export async function executeBulkImportCommit(
  options: BulkImportCommitOptions
): Promise<BulkImportCommitResult> {
  const {
    entityType,
    rows,
    duplicateStrategy,
    isAdmin,
    isOnlineDbConnected,
    targetStorage = storage,
    onProgress
  } = options;

  let cloudStorage = options.targetOnlineStorage;
  if (!cloudStorage && isAdmin && isOnlineDbConnected) {
    const mod = await import('../services/onlineStorage');
    cloudStorage = mod.onlineStorage;
  }

  let added = 0;
  let updated = 0;
  let skipped = 0;
  let failed = 0;
  const errors: string[] = [];

  const total = rows.length;

  for (let i = 0; i < total; i++) {
    const row = rows[i];
    const progressPct = total > 0 ? Math.round(((i + 1) / total) * 90) : 90;
    onProgress?.(progressPct, `در حال ثبت رکورد ${i + 1} از ${total}...`);

    const preRowSnapshot = targetStorage.captureTechnicalDataSnapshot();

    try {
      if (entityType === 'vehicles') {
        const vName = String(row['vehicleName'] || '').trim();
        const vModel = String(row['model'] || '').trim();
        if (!vName) throw new Error('نام خودرو خالی است.');

        const existing = targetStorage.getVehicles().find(v => {
          const nameMatch = normalizeBulkKey(v.name) === normalizeBulkKey(vName);
          return nameMatch && (vModel ? normalizeBulkKey(v.generation).includes(normalizeBulkKey(vModel)) : true);
        });

        if (existing && duplicateStrategy === 'skip') {
          skipped++;
          continue;
        }

        const vId = existing?.id || `veh-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`;
        const rawEngCode = String(row['engineCode'] || '').trim();
        let nextEngines: Engine[] = existing?.engines ? [...existing.engines] : [];

        if (rawEngCode) {
          const engIdx = nextEngines.findIndex(e => normalizeBulkKey(e.code) === normalizeBulkKey(rawEngCode));
          if (engIdx >= 0) {
            nextEngines[engIdx] = {
              ...nextEngines[engIdx],
              vehicleId: vId,
              fuelSystem: String(row['fuelSystem'] || nextEngines[engIdx].fuelSystem || 'انژکتوری')
            };
          } else {
            nextEngines.push({
              id: `eng-${Date.now()}-${Math.random().toString(36).substring(2, 5)}`,
              vehicleId: vId,
              code: rawEngCode,
              name: `موتور ${rawEngCode}`,
              fuelSystem: String(row['fuelSystem'] || 'انژکتوری'),
              valves: 16,
              displacementCc: 1600
            });
          }
        }

        const yearFrom = String(row['yearFrom'] || '').trim();
        const yearTo = String(row['yearTo'] || '').trim();
        const modelYears =
          yearFrom || yearTo
            ? yearFrom && yearTo
              ? `${yearFrom} - ${yearTo}`
              : yearFrom || yearTo
            : existing?.modelYears || '';

        const rawEcuIds = String(row['ecuIds'] || '').trim();
        const parsedEcuIds = rawEcuIds
          ? Array.from(new Set(rawEcuIds.split(/[,،]+/).map(s => s.trim()).filter(Boolean)))
          : existing?.ecuIds;

        const vObj: Vehicle = {
          ...(existing || {}),
          id: vId,
          manufacturerId: String(row['manufacturer'] || existing?.manufacturerId || 'iran_khodro'),
          name: vName,
          persianName: existing?.persianName || vName,
          generation: vModel || existing?.generation || '',
          modelYears,
          electricalSystem: String(row['fuelSystem'] || existing?.electricalSystem || 'انژکتوری استاندارد'),
          description: String(row['notes'] || existing?.description || ''),
          imageUrl: existing?.imageUrl,
          engines: nextEngines,
          ecuIds: parsedEcuIds,
          source: String(row['source'] || existing?.source || 'ورود گروهی فایل اکسل'),
          status: (row['verificationStatus'] as PublicationStatus) || existing?.status || 'published',
          createdAt: existing?.createdAt || Date.now(),
          updatedAt: Date.now()
        };

        if (isAdmin && isOnlineDbConnected && cloudStorage) {
          await cloudStorage.saveVehicle(vObj);
        }
        targetStorage.saveVehicle(vObj);
        if (existing) updated++;
        else added++;
      } else if (entityType === 'ecus') {
        const rawEcuId = String(row['ecuId'] || '').trim();
        const eName = String(row['ecuName'] || '').trim();
        const eBrand = String(row['manufacturer'] || '').trim();
        if (!eName || !eBrand) throw new Error('سازنده یا نام مدل ECU خالی است.');

        const allVehicles = targetStorage.getVehicles();
        const allEcus = targetStorage.getECUs();

        const matchById = rawEcuId
          ? allEcus.find(e => e.id.toLowerCase() === rawEcuId.toLowerCase())
          : undefined;
        const preResolved = resolveEcuTargetVehicle(row, allVehicles, matchById);
        const existing =
          matchById ||
          allEcus.find(
            e =>
              normalizeBulkKey(e.brand) === normalizeBulkKey(eBrand) &&
              normalizeBulkKey(e.model) === normalizeBulkKey(eName) &&
              (!preResolved.vehicleId || e.vehicleId === preResolved.vehicleId)
          );

        const targetVehicle = resolveEcuTargetVehicle(row, allVehicles, existing);
        if (!targetVehicle.vehicleId) {
          throw new Error(targetVehicle.reason || 'خودروی مرتبط برای ECU یافت نشد.');
        }

        if (existing && duplicateStrategy === 'skip') {
          skipped++;
          continue;
        }

        const rawConnIds = String(row['connectorIds'] || '').trim();
        const parsedConnIds = rawConnIds
          ? rawConnIds.split(/[,،]+/).map(s => s.trim()).filter(Boolean)
          : [];

        const ecuObj: ECU = {
          ...(existing || {}),
          id: existing?.id || rawEcuId || `ecu-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`,
          vehicleId: targetVehicle.vehicleId,
          engineId: existing?.engineId,
          brand: eBrand,
          model: eName,
          hardwareVersion: String(row['hardwareVersion'] || row['partNumber'] || existing?.hardwareVersion || ''),
          softwareVersion: String(row['softwareVersion'] || existing?.softwareVersion || ''),
          connectorCount: parsedConnIds.length > 0 ? Math.max(parsedConnIds.length, existing?.connectorCount || 0) : existing?.connectorCount || 2,
          description: String(row['notes'] || existing?.description || ''),
          imageUrl: existing?.imageUrl,
          status: (row['verificationStatus'] as PublicationStatus) || existing?.status || 'published'
        };

        if (isAdmin && isOnlineDbConnected && cloudStorage) {
          await cloudStorage.saveECU(ecuObj);
        }
        targetStorage.saveECU(ecuObj);
        if (existing) updated++;
        else added++;
      } else if (entityType === 'connectors') {
        const rawCId = String(row['connectorId'] || '').trim();
        const cName = String(row['connectorName'] || '').trim();
        if (!cName) throw new Error('نام سوکت خالی است.');

        const allVehicles = targetStorage.getVehicles();
        const allEcus = targetStorage.getECUs();
        const allConnectors = targetStorage.getConnectors();

        const matchById = rawCId
          ? allConnectors.find(c => c.id.toLowerCase() === rawCId.toLowerCase())
          : undefined;

        const parentRes = resolveConnectorParents(row, allVehicles, allEcus, matchById);
        if (!parentRes.vehicleId) {
          throw new Error(parentRes.reason || 'خودرو یا ECU مرتبط با سوکت یافت نشد.');
        }

        const existing =
          matchById ||
          allConnectors.find(
            c =>
              normalizeBulkKey(c.name) === normalizeBulkKey(cName) &&
              (c.ecuId || '') === (parentRes.ecuId || '') &&
              (c.vehicleId || '') === parentRes.vehicleId
          );

        if (existing && duplicateStrategy === 'skip') {
          skipped++;
          continue;
        }

        const cId = existing?.id || rawCId || `conn-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`;
        const connObj: Connector = {
          ...(existing || {}),
          id: cId,
          vehicleId: parentRes.vehicleId,
          ecuId: parentRes.ecuId,
          name: cName,
          codeName: existing?.codeName || cName,
          category: ((row['connectorType'] as ConnectorCategory) || existing?.category || 'ecu'),
          pinCount: Number(row['pinCount']) || existing?.pinCount || 32,
          rows: existing?.rows || 4,
          cols: existing?.cols || 8,
          shape: existing?.shape || 'grid',
          socketColor: String(row['viewOrientation'] || existing?.socketColor || 'خاکستری'),
          socketColorHex: existing?.socketColorHex || '#71717a',
          realImageUrl: existing?.realImageUrl,
          frontImageUrl: existing?.frontImageUrl,
          backImageUrl: existing?.backImageUrl,
          pinoutDiagramUrl: existing?.pinoutDiagramUrl,
          source: String(row['source'] || existing?.source || 'ورود گروهی فایل'),
          status: (row['verificationStatus'] as PublicationStatus) || existing?.status || 'published',
          notes: String(row['notes'] || existing?.notes || ''),
          pins: existing?.pins ? [...existing.pins] : [],
          createdAt: existing?.createdAt || Date.now(),
          updatedAt: Date.now()
        };

        if (isAdmin && isOnlineDbConnected && cloudStorage) {
          await cloudStorage.saveConnector(connObj);
        }
        targetStorage.saveConnector(connObj);
        if (existing) updated++;
        else added++;
      } else if (entityType === 'pins') {
        const cId = String(row['connectorId'] || '').trim();
        const conn = targetStorage.getConnectors().find(c => c.id.toLowerCase() === cId.toLowerCase());
        if (!conn) {
          throw new Error(`سوکت با شناسه «${cId}» یافت نشد.`);
        }

        const pinNum = String(row['pinNumber'] || '').trim();
        if (!pinNum) throw new Error('شماره پایه خالی است.');

        const existingPinIndex = conn.pins.findIndex(p => p.pinNumber.toLowerCase() === pinNum.toLowerCase());
        if (existingPinIndex >= 0 && duplicateStrategy === 'skip') {
          skipped++;
          continue;
        }

        const existingPin = existingPinIndex >= 0 ? conn.pins[existingPinIndex] : undefined;
        const newPin: ConnectorPin = {
          ...(existingPin || {}),
          id: existingPin?.id || `pin-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`,
          connectorId: conn.id,
          pinNumber: pinNum,
          pinName: existingPin?.pinName,
          row: existingPin?.row,
          col: existingPin?.col,
          wireColor: String(row['wireColor'] || existingPin?.wireColor || 'نامشخص'),
          wireHex: existingPin?.wireHex || '#ffffff',
          wireStripeHex: existingPin?.wireStripeHex,
          functionName: String(row['pinFunction'] || existingPin?.functionName || `پایه ${pinNum}`),
          dutyCategory: existingPin?.dutyCategory,
          pulseType: existingPin?.pulseType,
          signalType: (row['signalType'] as SignalType) || existingPin?.signalType || '12V_BAT',
          voltageRange: String(row['voltage'] || existingPin?.voltageRange || '12.0V'),
          testGuide: String(row['notes'] || existingPin?.testGuide || ''),
          source: String(row['source'] || existingPin?.source || '') || undefined,
          status: (row['verificationStatus'] as PublicationStatus) || existingPin?.status || 'published'
        };

        const nextPins = [...conn.pins];
        if (existingPinIndex >= 0) {
          nextPins[existingPinIndex] = newPin;
        } else {
          nextPins.push(newPin);
        }

        const updatedConn: Connector = {
          ...conn,
          pins: nextPins,
          updatedAt: Date.now()
        };

        if (isAdmin && isOnlineDbConnected && cloudStorage) {
          await cloudStorage.saveConnector(updatedConn);
        }
        targetStorage.saveConnector(updatedConn);
        if (existingPinIndex >= 0) updated++;
        else added++;
      } else if (entityType === 'fuseboxes') {
        const fbName = String(row['fuseBoxName'] || '').trim();
        const vIdRaw = String(row['vehicleId'] || '').trim();
        const hostVeh = targetStorage.getVehicles().find(v => v.id.toLowerCase() === vIdRaw.toLowerCase());
        if (!hostVeh) {
          throw new Error(`خودرو با شناسه «${vIdRaw}» برای جعبه‌فیوز یافت نشد.`);
        }

        const existing = targetStorage
          .getFuseBoxes(hostVeh.id)
          .find(f => normalizeBulkKey(f.name) === normalizeBulkKey(fbName));

        if (existing && duplicateStrategy === 'skip') {
          skipped++;
          continue;
        }

        const locStr = String(row['location'] || existing?.location || 'cabin').toLowerCase();
        const locKey: FuseBox['location'] = locStr.includes('engine') || locStr.includes('موتور')
          ? 'engine'
          : locStr.includes('battery') || locStr.includes('باتری')
          ? 'battery'
          : locStr.includes('trunk') || locStr.includes('صندوق')
          ? 'trunk'
          : 'cabin';

        const fbObj: FuseBox = {
          ...(existing || {}),
          id: existing?.id || `fb-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`,
          vehicleId: hostVeh.id,
          name: fbName,
          location: locKey,
          locationFa:
            locKey === 'engine'
              ? 'محفظه موتور'
              : locKey === 'battery'
              ? 'روی باتری'
              : locKey === 'trunk'
              ? 'صندوق عقب'
              : 'داخل کابین (زیر داشبورد)',
          modelYears: String(row['modelYear'] || existing?.modelYears || ''),
          engineCode: String(row['engineCode'] || existing?.engineCode || ''),
          realImageUrl: existing?.realImageUrl,
          diagramImageUrl: existing?.diagramImageUrl,
          coverDiagramUrl: existing?.coverDiagramUrl,
          notes: String(row['notes'] || existing?.notes || ''),
          source: String(row['source'] || existing?.source || 'ورود گروهی فایل'),
          status: (row['verificationStatus'] as PublicationStatus) || existing?.status || 'published',
          fuses: existing?.fuses ? [...existing.fuses] : [],
          relays: existing?.relays ? [...existing.relays] : []
        };

        if (isAdmin && isOnlineDbConnected && cloudStorage) {
          await cloudStorage.saveFuseBox(fbObj);
        }
        targetStorage.saveFuseBox(fbObj);
        if (existing) updated++;
        else added++;
      } else if (entityType === 'fuses') {
        const fbIdRaw = String(row['fuseBoxId'] || '').trim();
        const fb = targetStorage.getFuseBoxes().find(f => f.id.toLowerCase() === fbIdRaw.toLowerCase());
        if (!fb) {
          throw new Error(`جعبه‌فیوز با شناسه «${fbIdRaw}» یافت نشد.`);
        }

        const fCode = String(row['fuseNumber'] || '').trim();
        const existingIdx = fb.fuses.findIndex(f => f.code.toLowerCase() === fCode.toLowerCase());
        if (existingIdx >= 0 && duplicateStrategy === 'skip') {
          skipped++;
          continue;
        }

        const existingFuse = existingIdx >= 0 ? fb.fuses[existingIdx] : undefined;
        const fuseItem: Fuse = {
          ...(existingFuse || {}),
          id: existingFuse?.id || `fuse-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`,
          fuseBoxId: fb.id,
          code: fCode,
          ratingAmps: Number(row['amperage']) || existingFuse?.ratingAmps || 10,
          fuseType: (row['fuseType'] as Fuse['fuseType']) || existingFuse?.fuseType || 'standard',
          functionName: String(row['function'] || existingFuse?.functionName || `فیوز ${fCode}`),
          circuitDetails: String(row['protectedCircuit'] || row['function'] || existingFuse?.circuitDetails || ''),
          powerSupplyType: existingFuse?.powerSupplyType || '+15 (سوئیچ باز)',
          xPercent: existingFuse?.xPercent,
          yPercent: existingFuse?.yPercent,
          testTips: String(row['notes'] || existingFuse?.testTips || ''),
          source: String(row['source'] || existingFuse?.source || '') || undefined,
          status: (row['verificationStatus'] as PublicationStatus) || existingFuse?.status || 'published'
        };

        const nextFuses = [...fb.fuses];
        if (existingIdx >= 0) {
          nextFuses[existingIdx] = fuseItem;
        } else {
          nextFuses.push(fuseItem);
        }

        const updatedFb: FuseBox = {
          ...fb,
          fuses: nextFuses
        };

        if (isAdmin && isOnlineDbConnected && cloudStorage) {
          await cloudStorage.saveFuseBox(updatedFb);
        }
        targetStorage.saveFuseBox(updatedFb);
        if (existingIdx >= 0) updated++;
        else added++;
      } else if (entityType === 'relays') {
        const fbIdRaw = String(row['fuseBoxId'] || '').trim();
        const fb = targetStorage.getFuseBoxes().find(f => f.id.toLowerCase() === fbIdRaw.toLowerCase());
        if (!fb) {
          throw new Error(`جعبه‌فیوز با شناسه «${fbIdRaw}» یافت نشد.`);
        }

        const rCode = String(row['relayNumber'] || '').trim();
        const existingIdx = fb.relays.findIndex(r => r.code.toLowerCase() === rCode.toLowerCase());
        if (existingIdx >= 0 && duplicateStrategy === 'skip') {
          skipped++;
          continue;
        }

        const existingRelay = existingIdx >= 0 ? fb.relays[existingIdx] : undefined;
        const contactAmpsVal = Number(row['contactCurrentRating']) || existingRelay?.contactAmps || 30;

        const relayItem: Relay = {
          ...(existingRelay || {}),
          id: existingRelay?.id || `relay-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`,
          fuseBoxId: fb.id,
          code: rCode,
          name: String(row['relayName'] || existingRelay?.name || `رله ${rCode}`),
          rating: row['contactCurrentRating'] ? `12V ${contactAmpsVal}A` : existingRelay?.rating || `12V ${contactAmpsVal}A`,
          contactAmps: contactAmpsVal,
          coilVoltage: String(row['coilVoltage'] || existingRelay?.coilVoltage || '12V DC'),
          relayType: existingRelay?.relayType || 'cube_4pin',
          coilPins: existingRelay?.coilPins || '85 و 86',
          contactPins: existingRelay?.contactPins || '30 و 87',
          functionName: String(row['function'] || row['relayName'] || existingRelay?.functionName || ''),
          circuitDetails: String(row['relatedCircuit'] || existingRelay?.circuitDetails || ''),
          diagnostics: String(row['notes'] || existingRelay?.diagnostics || ''),
          source: String(row['source'] || existingRelay?.source || '') || undefined,
          xPercent: existingRelay?.xPercent,
          yPercent: existingRelay?.yPercent,
          status: (row['verificationStatus'] as PublicationStatus) || existingRelay?.status || 'published'
        };

        const nextRelays = [...fb.relays];
        if (existingIdx >= 0) {
          nextRelays[existingIdx] = relayItem;
        } else {
          nextRelays.push(relayItem);
        }

        const updatedFb: FuseBox = {
          ...fb,
          relays: nextRelays
        };

        if (isAdmin && isOnlineDbConnected && cloudStorage) {
          await cloudStorage.saveFuseBox(updatedFb);
        }
        targetStorage.saveFuseBox(updatedFb);
        if (existingIdx >= 0) updated++;
        else added++;
      } else if (entityType === 'images') {
        const rawId = String(row['recordId'] || '').trim();
        const rItemType = String(row['relatedItemType'] || '').trim().toLowerCase();
        const rItemId = String(row['relatedItemId'] || '').trim();
        const title = String(row['title'] || '').trim();
        const rawVehId = String(row['vehicleId'] || '').trim();

        const validVehicle = !rawVehId || targetStorage.getVehicles().some(v => v.id.toLowerCase() === rawVehId.toLowerCase());
        if (!validVehicle) {
          throw new Error(`خودرو با شناسه «${rawVehId}» یافت نشد.`);
        }

        let targetExists = false;
        if (rItemType === 'vehicle') targetExists = targetStorage.getVehicles().some(v => v.id.toLowerCase() === rItemId.toLowerCase());
        else if (rItemType === 'ecu') targetExists = targetStorage.getECUs().some(e => e.id.toLowerCase() === rItemId.toLowerCase());
        else if (rItemType === 'connector') targetExists = targetStorage.getConnectors().some(c => c.id.toLowerCase() === rItemId.toLowerCase());
        else if (rItemType === 'fusebox') targetExists = targetStorage.getFuseBoxes().some(f => f.id.toLowerCase() === rItemId.toLowerCase());
        else if (rItemType === 'diagram') targetExists = targetStorage.getWiringDiagrams().some(d => d.id.toLowerCase() === rItemId.toLowerCase());
        else if (rItemType === 'pin') targetExists = targetStorage.getConnectors().some(c => c.id.toLowerCase() === rItemId.toLowerCase());

        if (!targetExists) {
          throw new Error(`آیتم مرتبط «${rItemId}» از نوع «${rItemType}» یافت نشد.`);
        }

        const allMedia = targetStorage.getMediaItems();
        const existing =
          (rawId ? allMedia.find(m => m.id.toLowerCase() === rawId.toLowerCase()) : undefined) ||
          allMedia.find(
            m =>
              String(m.entityType).toLowerCase() === rItemType &&
              m.entityId.toLowerCase() === rItemId.toLowerCase() &&
              normalizeBulkKey(m.title) === normalizeBulkKey(title)
          );

        if (existing && duplicateStrategy === 'skip') {
          skipped++;
          continue;
        }

        const rawSource = String(row['source'] || '').trim();
        const looksLikeUrl = /^(https?:\/\/|data:image\/|\/)/i.test(rawSource);

        const mediaItem: MediaItem = {
          ...(existing || {}),
          id: existing?.id || rawId || `img-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`,
          title: title || existing?.title || 'تصویر فنی',
          description: String(row['description'] || existing?.description || ''),
          fileUrl: looksLikeUrl ? rawSource : existing?.fileUrl || rawSource || '',
          entityType: (rItemType as MediaItem['entityType']) || existing?.entityType || 'fusebox',
          entityId: rItemId,
          vehicleId: rawVehId || existing?.vehicleId || '',
          imageType: String(row['imageType'] || existing?.imageType || 'fusebox_real'),
          source: rawSource || existing?.source || '',
          status: (row['verificationStatus'] as PublicationStatus) || existing?.status || 'published',
          createdAt: existing?.createdAt || Date.now()
        };

        if (isAdmin && isOnlineDbConnected && cloudStorage) {
          await cloudStorage.saveMedia(mediaItem);
        } else {
          targetStorage.saveMediaItem(mediaItem);
        }
        if (existing) updated++;
        else added++;
      }
    } catch (rowErr) {
      targetStorage.restoreTechnicalDataSnapshot(preRowSnapshot);
      const errMsg = rowErr instanceof Error ? rowErr.message : String(rowErr);
      errors.push(`ردیف ${i + 1}: ${errMsg}`);
      failed++;
    }
  }

  return {
    added,
    updated,
    skipped,
    failed,
    errors
  };
}
