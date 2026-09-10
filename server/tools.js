// Реестр инструментов (function calling) для автономного вызова моделью.
// Пока единственный реализованный инструмент — run_code, потому что для него уже есть
// готовый локальный исполнитель (Piston/мок, см. server/codeExec.js). Веб-поиск НЕ вынесен
// сюда как отдельный инструмент: сейчас поиск целиком делегирован провайдеру через
// параметр `plugins:[{id:'web'}]` (см. server/llm.js streamChatCompletion) — у приложения
// нет собственного поискового backend, который можно было бы вызвать как tool-функцию.
// Чтобы добавить его как настоящий инструмент, нужен отдельный поисковый API/ключ — это
// не входит в текущий объём задачи.

const RUN_CODE_TOOL = {
  type: 'function',
  function: {
    name: 'run_code',
    description:
      'Выполняет код в изолированном контейнере (Piston) и возвращает stdout, stderr и код завершения. ' +
      'Используй, когда нужно реально проверить результат работы кода (посчитать, протестировать), а не просто написать его текстом.',
    parameters: {
      type: 'object',
      properties: {
        language: { type: 'string', description: 'Язык выполнения: python, javascript или bash' },
        code: { type: 'string', description: 'Исходный код для выполнения' },
        stdin: { type: 'string', description: 'Необязательные данные, передаваемые в stdin программы' },
      },
      required: ['language', 'code'],
    },
  },
};

// write_file — сохраняет текстовый файл в рабочую область текущего треда (режим «Компьютер»).
// Не выполняет код и не имеет доступа к файловой системе сервера за пределами
// каталога data/task-files/<threadId>/ — см. server/files.js.
const WRITE_FILE_TOOL = {
  type: 'function',
  function: {
    name: 'write_file',
    description:
      'Сохраняет текстовый файл (код, отчёт, документацию, конфиг и т.п.) в рабочую область текущей задачи. ' +
      'Используй, когда просят подготовить файл, скрипт или документ, который пользователь должен скачать. ' +
      'После завершения всех шагов задачи все сохранённые этим инструментом файлы будут собраны в один ' +
      'итоговый архив и предложены пользователю для скачивания — писать финальный ответ с полным текстом файла ' +
      'дополнительно не нужно, достаточно короткого пояснения.',
    parameters: {
      type: 'object',
      properties: {
        filename: { type: 'string', description: 'Имя файла с расширением, например script.py или README.md' },
        content: { type: 'string', description: 'Полное содержимое файла' },
      },
      required: ['filename', 'content'],
    },
  },
};

// create_document — создаёт бинарный документ (pdf/docx/xlsx/pptx/csv/rtf/odt) и сохраняет его в ту же
// рабочую область треда, что и write_file (см. server/documents.js). Для простого текста/кода/
// markdown/json и т.п. используется write_file — этот инструмент только для форматов, которые
// нельзя просто записать как текст (настоящий .xlsx/.pptx или правильный .pdf/.docx/.odt/.rtf).
// Старые бинарные .doc/.xls не предлагаются — модель должна выбрать docx/xlsx.
const CREATE_DOCUMENT_TOOL = {
  type: 'function',
  function: {
    name: 'create_document',
    description:
      'Создаёт готовый к скачиванию офисный документ в реальном бинарном формате и сохраняет его в файлы задачи. ' +
      'Форматы: pdf, docx (текстовые документы из content), xlsx (таблица из rows или sheets), ' +
      'pptx (презентация из slides), csv (таблица из rows), rtf и odt (текстовые документы из content, как pdf/docx). ' +
      'Используй вместо write_file, когда пользователь просит именно таблицу Excel, презентацию PowerPoint, ' +
      'PDF, Word, RTF или ODT документ — write_file сохраняет только как обычный текстовый файл и не подходит ' +
      'для этих форматов. Итоговый файл попадёт в общий архив задачи автоматически, как и файлы write_file.',
    parameters: {
      type: 'object',
      properties: {
        format: { type: 'string', enum: ['pdf', 'docx', 'xlsx', 'pptx', 'csv', 'rtf', 'odt'], description: 'Формат создаваемого документа' },
        filename: { type: 'string', description: 'Имя файла с правильным расширением, например «Отчёт.xlsx»' },
        title: { type: 'string', description: 'Заголовок документа. Используется для pdf/docx/rtf/odt и как имя листа по умолчанию для xlsx' },
        content: { type: 'string', description: 'Текст документа в markdown-подобном формате (заголовки #, списки -, ```код```) — для форматов pdf, docx, rtf, odt' },
        rows: {
          type: 'array',
          description: 'Табличные данные для csv или для xlsx с одним листом — массив строк, каждая строка — массив значений ячеек. Первая строка обычно заголовок таблицы',
          items: { type: 'array', items: {} },
        },
        sheets: {
          type: 'array',
          description: 'Для xlsx с несколькими листами — массив { name, rows }, где rows такой же формат, как в поле rows',
          items: {
            type: 'object',
            properties: { name: { type: 'string' }, rows: { type: 'array', items: { type: 'array', items: {} } } },
          },
        },
        slides: {
          type: 'array',
          description: 'Для pptx — массив слайдов { title, bullets, notes }, bullets — массив строк-пунктов',
          items: {
            type: 'object',
            properties: {
              title: { type: 'string' },
              bullets: { type: 'array', items: { type: 'string' } },
              notes: { type: 'string' },
            },
          },
        },
      },
      required: ['format', 'filename'],
    },
  },
};

module.exports = { RUN_CODE_TOOL, WRITE_FILE_TOOL, CREATE_DOCUMENT_TOOL };
