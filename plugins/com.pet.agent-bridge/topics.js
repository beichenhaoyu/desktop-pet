// topic 常量集中在此，避免发布方与订阅方把字符串写歪
export const PID = "com.pet.agent-bridge";
export const TOPIC_STATE = `${PID}:state`;
export const TOPIC_STATUS = `${PID}:status`;
export const TOPIC_CMD = `${PID}:cmd`;
export const TOPIC_WIDGET = `${PID}:widget`;
