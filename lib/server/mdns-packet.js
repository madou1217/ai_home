'use strict';

const AIH_MDNS_SERVICE = '_aih-server._tcp.local';
const MDNS_ADDRESS = '224.0.0.251';
const MDNS_PORT = 5353;

const RECORD_TYPES = Object.freeze({
  A: 1,
  PTR: 12,
  TXT: 16,
  AAAA: 28,
  SRV: 33,
  ANY: 255
});

const TYPE_NAMES = new Map(Object.entries(RECORD_TYPES).map(([name, value]) => [value, name]));

function normalizeDnsName(value) {
  return String(value || '').trim().replace(/^\.+|\.+$/g, '').toLowerCase();
}

function encodeName(value) {
  const labels = String(value || '').trim().replace(/^\.+|\.+$/g, '').split('.').filter(Boolean);
  const chunks = [];
  for (const label of labels) {
    const encoded = Buffer.from(label, 'utf8');
    if (encoded.length === 0 || encoded.length > 63) throw new Error('invalid_mdns_label');
    chunks.push(Buffer.from([encoded.length]), encoded);
  }
  chunks.push(Buffer.from([0]));
  return Buffer.concat(chunks);
}

function decodeName(buffer, startOffset, seen = new Set()) {
  let offset = Number(startOffset) || 0;
  let nextOffset = offset;
  let jumped = false;
  const labels = [];
  while (offset < buffer.length) {
    const length = buffer[offset];
    if ((length & 0xc0) === 0xc0) {
      if (offset + 1 >= buffer.length) throw new Error('invalid_mdns_name_pointer');
      const pointer = ((length & 0x3f) << 8) | buffer[offset + 1];
      if (seen.has(pointer) || pointer >= buffer.length) throw new Error('invalid_mdns_name_pointer');
      if (!jumped) nextOffset = offset + 2;
      seen.add(pointer);
      const pointed = decodeName(buffer, pointer, seen);
      if (pointed.name) labels.push(pointed.name);
      jumped = true;
      break;
    }
    if ((length & 0xc0) !== 0) throw new Error('invalid_mdns_label_length');
    offset += 1;
    if (length === 0) {
      if (!jumped) nextOffset = offset;
      break;
    }
    if (offset + length > buffer.length) throw new Error('truncated_mdns_name');
    labels.push(buffer.subarray(offset, offset + length).toString('utf8'));
    offset += length;
    if (!jumped) nextOffset = offset;
  }
  return { name: labels.filter(Boolean).join('.'), offset: nextOffset };
}

function recordTypeNumber(type) {
  if (Number.isInteger(type)) return type;
  return RECORD_TYPES[String(type || '').trim().toUpperCase()] || 0;
}

function encodeQuestion(question) {
  const type = recordTypeNumber(question.type || 'PTR');
  if (!type) throw new Error('invalid_mdns_question_type');
  const tail = Buffer.alloc(4);
  tail.writeUInt16BE(type, 0);
  tail.writeUInt16BE(Number(question.classCode) || 1, 2);
  return Buffer.concat([encodeName(question.name), tail]);
}

function encodeTxt(values) {
  const chunks = [];
  for (const value of Array.isArray(values) ? values : []) {
    const encoded = Buffer.from(String(value || ''), 'utf8');
    if (encoded.length > 255) throw new Error('invalid_mdns_txt_value');
    chunks.push(Buffer.from([encoded.length]), encoded);
  }
  return Buffer.concat(chunks);
}

function encodeIpv4(value) {
  const octets = String(value || '').split('.').map(Number);
  if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    throw new Error('invalid_mdns_ipv4');
  }
  return Buffer.from(octets);
}

function encodeRecordData(record) {
  const type = recordTypeNumber(record.type);
  if (type === RECORD_TYPES.PTR) return encodeName(record.data);
  if (type === RECORD_TYPES.TXT) return encodeTxt(record.data);
  if (type === RECORD_TYPES.A) return encodeIpv4(record.data);
  if (type === RECORD_TYPES.SRV) {
    const source = record.data && typeof record.data === 'object' ? record.data : {};
    const head = Buffer.alloc(6);
    head.writeUInt16BE(Number(source.priority) || 0, 0);
    head.writeUInt16BE(Number(source.weight) || 0, 2);
    head.writeUInt16BE(Number(source.port) || 0, 4);
    return Buffer.concat([head, encodeName(source.target)]);
  }
  if (Buffer.isBuffer(record.data)) return record.data;
  throw new Error('unsupported_mdns_record_type');
}

function encodeRecord(record) {
  const type = recordTypeNumber(record.type);
  if (!type) throw new Error('invalid_mdns_record_type');
  const data = encodeRecordData(record);
  const head = Buffer.alloc(10);
  head.writeUInt16BE(type, 0);
  head.writeUInt16BE(Number(record.classCode) || 0x8001, 2);
  head.writeUInt32BE(Math.max(0, Number(record.ttl) || 0), 4);
  head.writeUInt16BE(data.length, 8);
  return Buffer.concat([encodeName(record.name), head, data]);
}

function encodePacket(input = {}) {
  const questions = Array.isArray(input.questions) ? input.questions : [];
  const answers = Array.isArray(input.answers) ? input.answers : [];
  const authorities = Array.isArray(input.authorities) ? input.authorities : [];
  const additionals = Array.isArray(input.additionals) ? input.additionals : [];
  const header = Buffer.alloc(12);
  header.writeUInt16BE(Number(input.id) || 0, 0);
  header.writeUInt16BE(Number(input.flags) || 0, 2);
  header.writeUInt16BE(questions.length, 4);
  header.writeUInt16BE(answers.length, 6);
  header.writeUInt16BE(authorities.length, 8);
  header.writeUInt16BE(additionals.length, 10);
  return Buffer.concat([
    header,
    ...questions.map(encodeQuestion),
    ...answers.map(encodeRecord),
    ...authorities.map(encodeRecord),
    ...additionals.map(encodeRecord)
  ]);
}

function decodeQuestion(buffer, startOffset) {
  const decodedName = decodeName(buffer, startOffset);
  if (decodedName.offset + 4 > buffer.length) throw new Error('truncated_mdns_question');
  const typeCode = buffer.readUInt16BE(decodedName.offset);
  const classCode = buffer.readUInt16BE(decodedName.offset + 2);
  return {
    value: {
      name: decodedName.name,
      type: TYPE_NAMES.get(typeCode) || typeCode,
      typeCode,
      classCode
    },
    offset: decodedName.offset + 4
  };
}

function decodeTxt(data) {
  const values = [];
  for (let offset = 0; offset < data.length;) {
    const length = data[offset];
    offset += 1;
    if (offset + length > data.length) throw new Error('truncated_mdns_txt');
    values.push(data.subarray(offset, offset + length).toString('utf8'));
    offset += length;
  }
  return values;
}

function decodeRecordData(buffer, typeCode, dataOffset, dataLength) {
  const data = buffer.subarray(dataOffset, dataOffset + dataLength);
  if (typeCode === RECORD_TYPES.PTR) return decodeName(buffer, dataOffset).name;
  if (typeCode === RECORD_TYPES.TXT) return decodeTxt(data);
  if (typeCode === RECORD_TYPES.A && dataLength === 4) return Array.from(data).join('.');
  if (typeCode === RECORD_TYPES.SRV && dataLength >= 7) {
    return {
      priority: data.readUInt16BE(0),
      weight: data.readUInt16BE(2),
      port: data.readUInt16BE(4),
      target: decodeName(buffer, dataOffset + 6).name
    };
  }
  return Buffer.from(data);
}

function decodeRecord(buffer, startOffset) {
  const decodedName = decodeName(buffer, startOffset);
  if (decodedName.offset + 10 > buffer.length) throw new Error('truncated_mdns_record');
  const typeCode = buffer.readUInt16BE(decodedName.offset);
  const classCode = buffer.readUInt16BE(decodedName.offset + 2);
  const ttl = buffer.readUInt32BE(decodedName.offset + 4);
  const dataLength = buffer.readUInt16BE(decodedName.offset + 8);
  const dataOffset = decodedName.offset + 10;
  if (dataOffset + dataLength > buffer.length) throw new Error('truncated_mdns_record_data');
  return {
    value: {
      name: decodedName.name,
      type: TYPE_NAMES.get(typeCode) || typeCode,
      typeCode,
      classCode,
      ttl,
      data: decodeRecordData(buffer, typeCode, dataOffset, dataLength)
    },
    offset: dataOffset + dataLength
  };
}

function decodeSection(buffer, offset, count, decoder) {
  const values = [];
  let nextOffset = offset;
  for (let index = 0; index < count; index += 1) {
    const decoded = decoder(buffer, nextOffset);
    values.push(decoded.value);
    nextOffset = decoded.offset;
  }
  return { values, offset: nextOffset };
}

function decodeMdnsPacket(value) {
  const buffer = Buffer.isBuffer(value) ? value : Buffer.from(value || []);
  if (buffer.length < 12) throw new Error('truncated_mdns_header');
  const counts = {
    questions: buffer.readUInt16BE(4),
    answers: buffer.readUInt16BE(6),
    authorities: buffer.readUInt16BE(8),
    additionals: buffer.readUInt16BE(10)
  };
  let section = decodeSection(buffer, 12, counts.questions, decodeQuestion);
  const questions = section.values;
  section = decodeSection(buffer, section.offset, counts.answers, decodeRecord);
  const answers = section.values;
  section = decodeSection(buffer, section.offset, counts.authorities, decodeRecord);
  const authorities = section.values;
  section = decodeSection(buffer, section.offset, counts.additionals, decodeRecord);
  return {
    id: buffer.readUInt16BE(0),
    flags: buffer.readUInt16BE(2),
    questions,
    answers,
    authorities,
    additionals: section.values
  };
}

function buildMdnsQuery(service = AIH_MDNS_SERVICE) {
  return encodePacket({
    questions: [{ name: service, type: 'PTR', classCode: 0x8001 }]
  });
}

function buildMdnsAnnouncement(input = {}) {
  const service = String(input.service || AIH_MDNS_SERVICE);
  const instance = String(input.instance || 'AI Home Server._aih-server._tcp.local');
  const target = String(input.target || 'aih-server.local');
  const ttl = Math.max(0, Number(input.ttl) || 0);
  const records = [
    { name: service, type: 'PTR', ttl, classCode: 1, data: instance },
    {
      name: instance,
      type: 'SRV',
      ttl,
      data: { priority: 0, weight: 0, port: Number(input.port) || 0, target }
    },
    { name: instance, type: 'TXT', ttl, data: Array.isArray(input.txt) ? input.txt : [] },
    ...(Array.isArray(input.addresses) ? input.addresses : [])
      .map((address) => ({ name: target, type: 'A', ttl, data: address }))
  ];
  return encodePacket({ flags: 0x8400, answers: records });
}

function packetQueriesName(packet, names) {
  const accepted = new Set((Array.isArray(names) ? names : [names]).map(normalizeDnsName));
  return packet.questions.some((question) => {
    const name = normalizeDnsName(question.name);
    return accepted.has(name) || question.typeCode === RECORD_TYPES.ANY;
  });
}

module.exports = {
  AIH_MDNS_SERVICE,
  MDNS_ADDRESS,
  MDNS_PORT,
  RECORD_TYPES,
  buildMdnsAnnouncement,
  buildMdnsQuery,
  decodeMdnsPacket,
  encodePacket,
  normalizeDnsName,
  packetQueriesName
};
