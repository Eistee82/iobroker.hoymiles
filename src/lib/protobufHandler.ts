import * as path from "path";
import * as protobuf from "protobufjs";

// Command IDs
const CMD = {
	REAL_DATA_NEW: [0xa3, 0x11] as const,
	APP_INFO_DATA: [0xa3, 0x01] as const,
	GET_CONFIG: [0xa3, 0x09] as const,
	SET_CONFIG: [0xa3, 0x10] as const,
	COMMAND: [0xa3, 0x05] as const,
	ALARM_DATA: [0xa3, 0x04] as const,
	HIST_POWER: [0xa3, 0x15] as const,
	COMMAND_CLOUD: [0x23, 0x05] as const,
	HEARTBEAT: [0xa3, 0x14] as const,
} as const;

// Action codes for CommandResDTO
const ACTION = {
	DTU_REBOOT: 1,
	INV_REBOOT: 3,
	MI_START: 6,
	MI_SHUTDOWN: 7,
	LIMIT_POWER: 8,
	UPGRADE_MI: 15,
	ALARM_LIST: 42,
} as const;

const MAGIC = [0x48, 0x4d] as const; // "HM"
const FLAGS = [0x00, 0x01] as const;
const HEADER_SIZE = 10;
const DTU_TIME_OFFSET = 28800;

interface SgsData {
	serialNumber: string;
	firmwareVersion: number;
	voltage: number;
	frequency: number;
	activePower: number;
	reactivePower: number;
	current: number;
	powerFactor: number;
	temperature: number;
	warningNumber: number;
	crcChecksum: number;
	linkStatus: number;
	powerLimit: number;
	modulationIndexSignal: number;
}

interface PvData {
	serialNumber: string;
	portNumber: number;
	voltage: number;
	current: number;
	power: number;
	energyTotal: number;
	energyDaily: number;
	errorCode: number;
}

interface RealDataResult {
	dtuSn: string;
	timestamp: number;
	dtuPower: number;
	dtuDailyEnergy: number;
	sgs: SgsData[];
	pv: PvData[];
	meter: Record<string, unknown>[];
}

interface DtuInfo {
	deviceKind: number;
	swVersion: number;
	hwVersion: number;
	signalStrength: number;
	errorCode: number;
	dfs: number;
	encRand: string | null;
	type: number;
}

interface PvInfo {
	kind: number;
	sn: string;
	hwVersion: number;
	swVersion: number;
	gridVersion: number;
	bootVersion: number;
}

interface InfoDataResult {
	dtuSn: string;
	timestamp: number;
	deviceNumber: number;
	pvNumber: number;
	dtuInfo: DtuInfo | null;
	pvInfo: PvInfo[];
}

interface ConfigResult {
	limitPower: number;
	zeroExportEnable: number;
	serverSendTime: number;
	wifiRssi: number;
	serverPort: number;
	serverDomain: string;
	wifiSsid: string;
	dtuSn: string;
	dhcpSwitch: number;
	invType: number;
}

interface AlarmEntry {
	sn: string;
	code: number;
	num: number;
	startTime: number;
	endTime: number;
	data1: number;
	data2: number;
}

interface AlarmDataResult {
	dtuSn: string;
	timestamp: number;
	alarms: AlarmEntry[];
}

interface ParsedResponse {
	cmdHigh: number;
	cmdLow: number;
	payload: Buffer;
	totalLen: number;
}

/** Handler for encoding and decoding Hoymiles protobuf messages. */
class ProtobufHandler {
	public protos: Record<string, protobuf.Root>;

	/** Create a new ProtobufHandler instance. */
	constructor() {
		this.protos = {};
	}

	/** Load all protobuf definition files from the proto directory. */
	async loadProtos(): Promise<void> {
		const protoDir = path.join(__dirname, "proto");
		const files = [
			"RealDataNew",
			"GetConfig",
			"SetConfig",
			"CommandPB",
			"AlarmData",
			"WarnData",
			"APPInformationData",
			"APPHeartbeatPB",
			"AppGetHistPower",
			"EventData",
			"NetworkInfo",
		];

		for (const file of files) {
			const root = await protobuf.load(path.join(protoDir, `${file}.proto`));
			this.protos[file] = root;
		}
	}

	/**
	 * CRC16 with polynomial 0x18005 (CRC-16/MODBUS).
	 *
	 * @param buffer - The data to compute CRC over
	 * @returns The 16-bit CRC value
	 */
	crc16(buffer: Uint8Array): number {
		let crc = 0xffff;
		for (const byte of buffer) {
			crc ^= byte;
			for (let i = 0; i < 8; i++) {
				if (crc & 1) {
					crc = (crc >> 1) ^ 0xa001;
				} else {
					crc >>= 1;
				}
			}
		}
		return crc;
	}

	/**
	 * Build a framed message with HM header.
	 *
	 * @param cmdHigh - High byte of command ID
	 * @param cmdLow - Low byte of command ID
	 * @param protobufPayload - The protobuf-encoded payload
	 * @returns Complete message buffer with header
	 */
	buildMessage(cmdHigh: number, cmdLow: number, protobufPayload: Uint8Array): Buffer {
		const crc = this.crc16(protobufPayload);
		const totalLen = HEADER_SIZE + protobufPayload.length;
		const header = Buffer.alloc(HEADER_SIZE);
		header[0] = MAGIC[0];
		header[1] = MAGIC[1];
		header[2] = cmdHigh;
		header[3] = cmdLow;
		header[4] = FLAGS[0];
		header[5] = FLAGS[1];
		header[6] = (crc >> 8) & 0xff;
		header[7] = crc & 0xff;
		header[8] = (totalLen >> 8) & 0xff;
		header[9] = totalLen & 0xff;
		return Buffer.concat([header, protobufPayload]);
	}

	/**
	 * Parse a raw response buffer into command ID and payload.
	 *
	 * @param buffer - The raw message buffer
	 * @returns Parsed response or null if invalid
	 */
	parseResponse(buffer: Buffer): ParsedResponse | null {
		if (buffer.length < HEADER_SIZE) {
			return null;
		}
		if (buffer[0] !== MAGIC[0] || buffer[1] !== MAGIC[1]) {
			return null;
		}

		const cmdHigh = buffer[2];
		const cmdLow = buffer[3];
		const totalLen = (buffer[8] << 8) | buffer[9];
		const payload = buffer.slice(HEADER_SIZE, totalLen);

		return {
			cmdHigh,
			cmdLow,
			payload,
			totalLen,
		};
	}

	// --- Encode Requests ---

	/**
	 * Encode a RealDataNew request message.
	 *
	 * @param timestamp - Unix timestamp in seconds
	 * @returns Framed message buffer
	 */
	encodeRealDataNewRequest(timestamp: number): Buffer {
		const ResDTO = this.protos.RealDataNew.lookupType("RealDataNewResDTO");
		const msg = ResDTO.create({
			offset: DTU_TIME_OFFSET,
			time: timestamp,
		});
		const payload = ResDTO.encode(msg).finish();
		return this.buildMessage(CMD.REAL_DATA_NEW[0], CMD.REAL_DATA_NEW[1], payload);
	}

	/**
	 * Encode an AppInfoData request message.
	 *
	 * @param timestamp - Unix timestamp in seconds
	 * @returns Framed message buffer
	 */
	encodeInfoRequest(timestamp: number): Buffer {
		const ResDTO = this.protos.APPInformationData.lookupType("APPInfoDataResDTO");
		const msg = ResDTO.create({
			time: timestamp,
			offset: DTU_TIME_OFFSET,
		});
		const payload = ResDTO.encode(msg).finish();
		return this.buildMessage(CMD.APP_INFO_DATA[0], CMD.APP_INFO_DATA[1], payload);
	}

	/**
	 * Encode a GetConfig request message.
	 *
	 * @param timestamp - Unix timestamp in seconds
	 * @returns Framed message buffer
	 */
	encodeGetConfigRequest(timestamp: number): Buffer {
		const ResDTO = this.protos.GetConfig.lookupType("GetConfigResDTO");
		const msg = ResDTO.create({
			offset: DTU_TIME_OFFSET,
			time: timestamp,
		});
		const payload = ResDTO.encode(msg).finish();
		return this.buildMessage(CMD.GET_CONFIG[0], CMD.GET_CONFIG[1], payload);
	}

	/**
	 * Encode an alarm list trigger command.
	 *
	 * @param timestamp - Unix timestamp in seconds
	 * @returns Framed message buffer
	 */
	encodeAlarmTrigger(timestamp: number): Buffer {
		const ResDTO = this.protos.CommandPB.lookupType("CommandResDTO");
		const msg = ResDTO.create({
			time: timestamp,
			action: ACTION.ALARM_LIST,
			package_nub: 1,
			tid: timestamp,
		});
		const payload = ResDTO.encode(msg).finish();
		return this.buildMessage(CMD.COMMAND[0], CMD.COMMAND[1], payload);
	}

	/**
	 * Encode a power limit command.
	 *
	 * @param percent - Power limit percentage (2-100)
	 * @param timestamp - Unix timestamp in seconds
	 * @returns Framed message buffer
	 */
	encodeSetPowerLimit(percent: number, timestamp: number): Buffer {
		const limitValue = Math.round(percent * 10);
		const ResDTO = this.protos.CommandPB.lookupType("CommandResDTO");
		const msg = ResDTO.create({
			time: timestamp,
			action: ACTION.LIMIT_POWER,
			dev_kind: 1,
			package_nub: 1,
			tid: timestamp,
			data: `A:${limitValue},B:0,C:0\r`,
		});
		const payload = ResDTO.encode(msg).finish();
		return this.buildMessage(CMD.COMMAND[0], CMD.COMMAND[1], payload);
	}

	/**
	 * Encode an inverter turn-on command.
	 *
	 * @param timestamp - Unix timestamp in seconds
	 * @returns Framed message buffer
	 */
	encodeInverterOn(timestamp: number): Buffer {
		const ResDTO = this.protos.CommandPB.lookupType("CommandResDTO");
		const msg = ResDTO.create({
			time: timestamp,
			action: ACTION.MI_START,
			dev_kind: 1,
			package_nub: 1,
			tid: timestamp,
		});
		const payload = ResDTO.encode(msg).finish();
		return this.buildMessage(CMD.COMMAND_CLOUD[0], CMD.COMMAND_CLOUD[1], payload);
	}

	/**
	 * Encode an inverter shutdown command.
	 *
	 * @param timestamp - Unix timestamp in seconds
	 * @returns Framed message buffer
	 */
	encodeInverterOff(timestamp: number): Buffer {
		const ResDTO = this.protos.CommandPB.lookupType("CommandResDTO");
		const msg = ResDTO.create({
			time: timestamp,
			action: ACTION.MI_SHUTDOWN,
			dev_kind: 1,
			package_nub: 1,
			tid: timestamp,
		});
		const payload = ResDTO.encode(msg).finish();
		return this.buildMessage(CMD.COMMAND_CLOUD[0], CMD.COMMAND_CLOUD[1], payload);
	}

	/**
	 * Encode an inverter reboot command.
	 *
	 * @param timestamp - Unix timestamp in seconds
	 * @returns Framed message buffer
	 */
	encodeInverterReboot(timestamp: number): Buffer {
		const ResDTO = this.protos.CommandPB.lookupType("CommandResDTO");
		const msg = ResDTO.create({
			time: timestamp,
			action: ACTION.INV_REBOOT,
			dev_kind: 1,
			package_nub: 1,
			tid: timestamp,
		});
		const payload = ResDTO.encode(msg).finish();
		return this.buildMessage(CMD.COMMAND_CLOUD[0], CMD.COMMAND_CLOUD[1], payload);
	}

	/**
	 * Encode a historical power request.
	 *
	 * @param timestamp - Unix timestamp in seconds
	 * @returns Framed message buffer
	 */
	encodeHistPowerRequest(timestamp: number): Buffer {
		const ResDTO = this.protos.AppGetHistPower.lookupType("AppGetHistPowerResDTO");
		const msg = ResDTO.create({
			offset: DTU_TIME_OFFSET,
			requested_time: timestamp,
		});
		const payload = ResDTO.encode(msg).finish();
		return this.buildMessage(CMD.HIST_POWER[0], CMD.HIST_POWER[1], payload);
	}

	// --- Decode Responses ---

	/**
	 * Decode a RealDataNew response payload.
	 *
	 * @param payload - The protobuf payload buffer
	 * @returns Decoded real data result
	 */
	decodeRealDataNew(payload: Buffer): RealDataResult {
		const ReqDTO = this.protos.RealDataNew.lookupType("RealDataNewReqDTO");
		const msg = ReqDTO.decode(payload);
		const obj = ReqDTO.toObject(msg, { longs: Number, defaults: true }) as Record<string, unknown>;

		const result: RealDataResult = {
			dtuSn: (obj.device_serial_number as string) || "",
			timestamp: (obj.timestamp as number) || 0,
			dtuPower: Number(obj.dtu_power) || 0,
			dtuDailyEnergy: Number(obj.dtu_daily_energy) || 0,
			sgs: [],
			pv: [],
			meter: [],
		};

		if (obj.sgs_data) {
			for (const sgs of obj.sgs_data as Record<string, unknown>[]) {
				result.sgs.push({
					serialNumber: (sgs.serial_number as string) || "",
					firmwareVersion: (sgs.firmware_version as number) || 0,
					voltage: ((sgs.voltage as number) || 0) / 10,
					frequency: ((sgs.frequency as number) || 0) / 100,
					activePower: (sgs.active_power as number) || 0,
					reactivePower: (sgs.reactive_power as number) || 0,
					current: ((sgs.current as number) || 0) / 100,
					powerFactor: ((sgs.power_factor as number) || 0) / 1000,
					temperature: ((sgs.temperature as number) || 0) / 10,
					warningNumber: (sgs.warning_number as number) || 0,
					crcChecksum: (sgs.crc_checksum as number) || 0,
					linkStatus: (sgs.link_status as number) || 0,
					powerLimit: ((sgs.power_limit as number) || 0) / 10,
					modulationIndexSignal: (sgs.modulation_index_signal as number) || 0,
				});
			}
		}

		if (obj.pv_data) {
			for (const pv of obj.pv_data as Record<string, unknown>[]) {
				result.pv.push({
					serialNumber: (pv.serial_number as string) || "",
					portNumber: (pv.port_number as number) || 0,
					voltage: ((pv.voltage as number) || 0) / 10,
					current: ((pv.current as number) || 0) / 100,
					power: (pv.power as number) || 0,
					energyTotal: (pv.energy_total as number) || 0,
					energyDaily: (pv.energy_daily as number) || 0,
					errorCode: (pv.error_code as number) || 0,
				});
			}
		}

		if (obj.meter_data) {
			for (const meter of obj.meter_data as Record<string, unknown>[]) {
				result.meter.push(meter);
			}
		}

		return result;
	}

	/**
	 * Decode an AppInfoData response payload.
	 *
	 * @param payload - The protobuf payload buffer
	 * @returns Decoded info data result
	 */
	decodeInfoData(payload: Buffer): InfoDataResult {
		const ReqDTO = this.protos.APPInformationData.lookupType("APPInfoDataReqDTO");
		const msg = ReqDTO.decode(payload);
		const obj = ReqDTO.toObject(msg, { longs: Number, defaults: true }) as Record<string, unknown>;

		const result: InfoDataResult = {
			dtuSn: (obj.dtu_serial_number as string) || "",
			timestamp: (obj.timestamp as number) || 0,
			deviceNumber: (obj.device_number as number) || 0,
			pvNumber: (obj.pv_number as number) || 0,
			dtuInfo: null,
			pvInfo: [],
		};

		if (obj.dtu_info) {
			const di = obj.dtu_info as Record<string, unknown>;
			result.dtuInfo = {
				deviceKind: (di.device_kind as number) || 0,
				swVersion: (di.dtu_sw_version as number) || 0,
				hwVersion: (di.dtu_hw_version as number) || 0,
				signalStrength: (di.signal_strength as number) || 0,
				errorCode: (di.dtu_error_code as number) || 0,
				dfs: Number(di.dfs) || 0,
				encRand: (di.enc_rand as string) || null,
				type: (di.type as number) || 0,
			};
		}

		if (obj.pv_info) {
			for (const pv of obj.pv_info as Record<string, unknown>[]) {
				result.pvInfo.push({
					kind: (pv.pv_kind as number) || 0,
					sn: (pv.pv_sn as string) || "",
					hwVersion: (pv.pv_hw_version as number) || 0,
					swVersion: (pv.pv_sw_version as number) || 0,
					gridVersion: (pv.pv_grid_version as number) || 0,
					bootVersion: (pv.pv_boot_version as number) || 0,
				});
			}
		}

		return result;
	}

	/**
	 * Decode a GetConfig response payload.
	 *
	 * @param payload - The protobuf payload buffer
	 * @returns Decoded config result
	 */
	decodeGetConfig(payload: Buffer): ConfigResult {
		const ReqDTO = this.protos.GetConfig.lookupType("GetConfigReqDTO");
		const msg = ReqDTO.decode(payload);
		const obj = ReqDTO.toObject(msg, { longs: Number, defaults: true }) as Record<string, unknown>;

		return {
			limitPower: (obj.limit_power_mypower as number) || 0,
			zeroExportEnable: (obj.zero_export_enable as number) || 0,
			serverSendTime: (obj.server_send_time as number) || 0,
			wifiRssi: (obj.wifi_rssi as number) || 0,
			serverPort: (obj.serverport as number) || 0,
			serverDomain: (obj.server_domain_name as string) || "",
			wifiSsid: (obj.wifi_ssid as string) || "",
			dtuSn: (obj.dtu_sn as string) || "",
			dhcpSwitch: (obj.dhcp_switch as number) || 0,
			invType: (obj.inv_type as number) || 0,
		};
	}

	/**
	 * Decode an AlarmData response payload.
	 *
	 * @param payload - The protobuf payload buffer
	 * @returns Decoded alarm data result
	 */
	decodeAlarmData(payload: Buffer): AlarmDataResult {
		const ReqDTO = this.protos.AlarmData.lookupType("WInfoReqDTO");
		const msg = ReqDTO.decode(payload);
		const obj = ReqDTO.toObject(msg, { longs: Number, defaults: true }) as Record<string, unknown>;

		const alarms: AlarmEntry[] = [];
		if (obj.mWInfo) {
			for (const w of obj.mWInfo as Record<string, unknown>[]) {
				alarms.push({
					sn: (w.pv_sn as string) || "",
					code: (w.WCode as number) || 0,
					num: (w.WNum as number) || 0,
					startTime: (w.WTime1 as number) || 0,
					endTime: (w.WTime2 as number) || 0,
					data1: (w.WData1 as number) || 0,
					data2: (w.WData2 as number) || 0,
				});
			}
		}

		return {
			dtuSn: (obj.dtu_sn as string) || "",
			timestamp: (obj.time as number) || 0,
			alarms,
		};
	}

	/**
	 * Decode a HistPower response payload.
	 *
	 * @param payload - The protobuf payload buffer
	 * @returns Decoded historical power data
	 */
	decodeHistPower(payload: Buffer): Record<string, unknown> {
		const ReqDTO = this.protos.AppGetHistPower.lookupType("AppGetHistPowerReqDTO");
		const msg = ReqDTO.decode(payload);
		return ReqDTO.toObject(msg, { longs: Number, defaults: true }) as Record<string, unknown>;
	}
}

export { ProtobufHandler, CMD, ACTION, HEADER_SIZE };
export type {
	SgsData,
	PvData,
	RealDataResult,
	DtuInfo,
	PvInfo,
	InfoDataResult,
	ConfigResult,
	AlarmEntry,
	AlarmDataResult,
	ParsedResponse,
};
