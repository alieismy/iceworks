import { checkIsAliInternal } from '@iceworks/common-service';
import { getUserInfo } from '@iceworks/user-service';
import axios from 'axios';
import { ALI_DIP_PRO } from '@iceworks/constant';
import { KeystrokeStats, FileChange } from '../recorders/keystrokeStats';
import { FileChangeInfo, FileEventInfo, FileUsageInfo } from '../storages/file';
import { getEditorInfo, getExtensionInfo, getSystemInfo, SystemInfo, EditorInfo, ExtensionInfo } from './env';
import { ProjectInfo } from '../storages/project';
import { window } from 'vscode';
import logger from './logger';
import { ONE_SEC_MILLISECONDS } from '../constants';
import { FileUsage, UsageStats } from '../recorders/usageStats';

// eslint-disable-next-line
import forIn = require('lodash.forin');

enum PlayloadType {
  KEYSTROKES_RECORD = 'keystrokes',
  USAGES_RECORD = 'usages',
}

type PlayloadData = UsagePayload[]|KeystrokesPayload[];

const url = `${ALI_DIP_PRO}/api`;

interface ProjectParams extends Omit<ProjectInfo, 'name'|'directory'> {
  projectName: PropType<ProjectInfo, 'name'>;
  projectDirectory: PropType<ProjectInfo, 'directory'>;
}

interface UserInfo {
  userId: string;
}

interface KeystrokesPayload extends
  ProjectParams,
  EditorInfo,
  ExtensionInfo,
  SystemInfo,
  UserInfo,
  Omit<FileChangeInfo, keyof FileEventInfo> {
}

interface UsagePayload extends
  ProjectParams,
  EditorInfo,
  ExtensionInfo,
  SystemInfo,
  UserInfo,
  FileUsageInfo {
}

/**
 * ONLY SEND DATA IN ALIBABA INTERNAL!!!
 */
async function checkIsSendable() {
  // TODO
  // checkIsAliInternal is judged by network environment
  // There is a situation: the user is a member of Alibaba,
  // but he works at home does not connect to the intranet.
  const isAliInternal = await checkIsAliInternal();
  return isAliInternal;
}

function checkIsSendNow(): boolean {
  // Prevent multi window resource competition
  return window.state.focused;
}

function transformDataToPayload(keystrokeStats: KeystrokeStats|UsageStats):
Array<KeystrokesPayload|UsagePayload> {
  const data: Array<KeystrokesPayload|UsagePayload> = [];
  const { files, project } = keystrokeStats;
  const { name: projectName, directory: projectDirectory, gitRepository, gitBranch, gitTag } = project;
  const defaultValues = {
    projectName,
    projectDirectory,
    gitRepository,
    gitBranch,
    gitTag,

    // placeholder, will fill it before send
    userId: '',
    editorName: '',
    editorVersion: '',
    extensionName: '',
    extensionVersion: '',
    os: '',
    hostname: '',
    timezone: '',
  };
  forIn(files, (file: FileChange|FileUsage) => {
    data.push({
      ...file,
      ...defaultValues,
    });
  });
  return data;
}

export async function appendKeystrokesPayload(keystrokeStats: KeystrokeStats) {
  const playload = transformDataToPayload(keystrokeStats);
  logger.info('[sender][appendKeystrokesPayload] playload length:', playload.length);
  await appendPayloadData(PlayloadType.KEYSTROKES_RECORD, playload);
}

export async function appendUsageTimePayload(usageStats: UsageStats) {
  const playload = transformDataToPayload(usageStats);
  logger.info('[sender][appendUsageTimePayload] playload length:', playload.length);
  await appendPayloadData(PlayloadType.USAGES_RECORD, playload);
}

export async function sendPayload() {
  logger.info('[sender][sendPayload] run');
  const isSendable = await checkIsSendable();
  const isSendNow = checkIsSendNow();
  await Promise.all([PlayloadType.KEYSTROKES_RECORD, PlayloadType.USAGES_RECORD].map(async (TYPE) => {
    logger.info(`[sender][sendPayload] ${TYPE} isSendable: ${isSendable}`);
    if (isSendable) {
      logger.info(`[sender][sendPayload] ${TYPE} isSendNow: ${isSendNow}`);
      await sendPayloadData(TYPE);
    } else {
      await clearPayloadData(TYPE);
    }
  }));
}

const timeout = ONE_SEC_MILLISECONDS * 5;
async function send(api: string, data: any) {
  const response = await axios({
    method: 'post',
    url: `${url}${api}`,
    timeout,
    data: {
      data,
    },
  });
  return response;
}

function isResponseOk(response) {
  return response.status === 200 && response.data && response.data.success;
}

async function sendBulkCreate(type, playloadData, extra) {
  logger.info(`[sender][sendBulkCreate] run, ${type}'s playloadData: ${playloadData.length}`);
  try {
    const bulkCreateResponse = await send(`/${type}/_bulkCreate`, playloadData.map((record: any) => ({
      ...record,
      ...extra,
    })));

    logger.info(`[sender][sendBulkCreate] response: status(${bulkCreateResponse.status}), statusText(${bulkCreateResponse.statusText})`);
    if (!isResponseOk(bulkCreateResponse)) {
      logger.info(`[sender][sendBulkCreate] data: ${bulkCreateResponse.data}`);
      throw new Error(bulkCreateResponse.data.message);
    }
  } catch (e) {
    // if got error, write back the data and resend it in the next cycle
    await appendPayloadData(type, playloadData);
    logger.error('[sender][sendBulkCreate] got error:', e);
    throw e;
  }
}

async function sendPayloadData(type: PlayloadType) {
  // TODO get user info may fail
  const { empId } = await getUserInfo();
  const playload = await getPayloadData(type);
  const playloadLength = playload.length;

  logger.info(`[sender][sendPayloadData] run, ${type}'s playloadLength: ${playloadLength}`);
  if (playloadLength) {
    const editorInfo = getEditorInfo();
    const extensionInfo = getExtensionInfo();
    const systemInfo = await getSystemInfo();
    const extra = {
      ...editorInfo,
      ...extensionInfo,
      ...systemInfo,
      userId: empId,
    };

    if (playloadLength > 100) {
      const batchPlayloadList = [];
      while (playload.length) {
        batchPlayloadList.push(playload.splice(0, 10));
      }
      await Promise.all(batchPlayloadList.map(async (batchPlayload) => {
        await sendBulkCreate(type, batchPlayload, extra);
      }));
    } else {
      await sendBulkCreate(type, playload, extra);
    }
  }
}

const playloadData: any = {
  [PlayloadType.KEYSTROKES_RECORD]: [],
  [PlayloadType.USAGES_RECORD]: [],
};
async function getPayloadData(type: PlayloadType): Promise<PlayloadData> {
  return playloadData[type].splice(0);
}
async function clearPayloadData(type: PlayloadType) {
  playloadData[type] = [];
}
async function appendPayloadData(type: PlayloadType, data: PlayloadData) {
  playloadData[type] = playloadData[type].concat(data);
}

/**
 * If payload is too large, may be a large number of requests errors
 */
export async function checkPayloadIsLimited() {
  await Promise.all([PlayloadType.KEYSTROKES_RECORD, PlayloadType.USAGES_RECORD].map(async (TYPE) => {
    if (playloadData[TYPE].length > 1000) {
      await clearPayloadData(TYPE);
    }
  }));
}
