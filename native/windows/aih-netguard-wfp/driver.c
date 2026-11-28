/*
 * aih-netguard WFP callout (prototype).
 *
 * Blocks ALE_AUTH_CONNECT for a set of process IDs supplied by user mode.
 * The user-mode service extends the PID set for the whole process tree and
 * can later add ALE_CONNECT_REDIRECT for transparent proxying.
 *
 * This is a test-signing driver; it is not loaded by the repository build.
 */
/*
 * The WFP layer/sub-layer GUIDs used here are declared with DEFINE_GUID in
 * fwpmk.h. The WDK NuGet import library does not export them, so let
 * guiddef.h emit selectany definitions into this object instead.
 */
#define INITGUID 1

/*
 * Build workaround: the WDK NuGet package's `shared` folder ships no
 * ntdef.h, so the build copies the SDK 16299 ntdef.h from the winsdk-10
 * mirror. That copy predates UTF8_STRING, while the WDK 28000 wdm.h
 * declares RtlInitUTF8String/RtlFreeUTF8String whenever NTDDI_VERSION is
 * at or above WIN10_VB. Pull ntdef.h in first (its include guard then
 * skips inside ntddk.h) and fill in the types wdm.h expects. Remove this
 * block once a complete WDK includes its own ntdef.h.
 */
#include <ntdef.h>
#ifndef AIHNG_UTF8_STRING_TYPES
#define AIHNG_UTF8_STRING_TYPES
typedef STRING UTF8_STRING, *PUTF8_STRING;
typedef const STRING *PCUTF8_STRING;
#endif
#include <ntddk.h>
#include <fwpsk.h>
#include <fwpmk.h>

#define AIHNG_DEVICE_NAME   L"\\Device\\AihNetGuard"
#define AIHNG_SYMLINK_NAME  L"\\DosDevices\\AihNetGuard"
#define AIHNG_MAX_PIDS      512

#define AIHNG_IOCTL_SET_PIDS \
    CTL_CODE(FILE_DEVICE_UNKNOWN, 0x801, METHOD_BUFFERED, FILE_ANY_ACCESS)
#define AIHNG_IOCTL_GET_STATUS \
    CTL_CODE(FILE_DEVICE_UNKNOWN, 0x802, METHOD_BUFFERED, FILE_ANY_ACCESS)

typedef struct _AIHNG_STATUS {
    ULONG Count;
    ULONG Blocked;
} AIHNG_STATUS;

static const GUID AIHNG_PROVIDER_KEY =
    {0x6f70f0b4, 0xa8d1, 0x4f6d, {0x9b, 0x5e, 0x3a, 0x2c, 0x71, 0x88, 0x0e, 0x11}};
static const GUID AIHNG_SUBLAYER_KEY =
    {0x6f70f0b5, 0xa8d1, 0x4f6d, {0x9b, 0x5e, 0x3a, 0x2c, 0x71, 0x88, 0x0e, 0x11}};
static const GUID AIHNG_CALLOUT_V4_KEY =
    {0x6f70f0b6, 0xa8d1, 0x4f6d, {0x9b, 0x5e, 0x3a, 0x2c, 0x71, 0x88, 0x0e, 0x11}};
static const GUID AIHNG_CALLOUT_V6_KEY =
    {0x6f70f0b7, 0xa8d1, 0x4f6d, {0x9b, 0x5e, 0x3a, 0x2c, 0x71, 0x88, 0x0e, 0x11}};

static PDEVICE_OBJECT g_DeviceObject = NULL;
static HANDLE g_EngineHandle = NULL;
static UINT32 g_CalloutIdV4 = 0;
static UINT32 g_CalloutIdV6 = 0;
static UINT64 g_FilterIdV4 = 0;
static UINT64 g_FilterIdV6 = 0;
static KSPIN_LOCK g_PidLock;
static ULONG g_PidCount = 0;
static ULONG g_Pids[AIHNG_MAX_PIDS];
static volatile LONG g_Blocked = 0;

static BOOLEAN
AihngIsProtected(_In_ UINT32 ProcessId)
{
    ULONG index;
    BOOLEAN found = FALSE;
    KIRQL irql;

    KeAcquireSpinLock(&g_PidLock, &irql);
    for (index = 0; index < g_PidCount; index++) {
        if (g_Pids[index] == ProcessId) {
            found = TRUE;
            break;
        }
    }
    KeReleaseSpinLock(&g_PidLock, irql);
    return found;
}

static BOOLEAN
AihngIsLoopbackRemote(_In_ const FWPS_INCOMING_VALUES0 *inFixedValues)
{
    if (RtlEqualMemory(&inFixedValues->layerId, &FWPM_LAYER_ALE_AUTH_CONNECT_V4,
                       sizeof(GUID))) {
        const FWPS_INCOMING_VALUE0 *remote =
            &inFixedValues->incomingValue[FWPS_FIELD_ALE_AUTH_CONNECT_V4_IP_REMOTE_ADDRESS];
        const FWPS_INCOMING_VALUE0 *local =
            &inFixedValues->incomingValue[FWPS_FIELD_ALE_AUTH_CONNECT_V4_IP_LOCAL_ADDRESS];
        UINT32 addresses[2] = {0, 0};
        if (remote->value.type == FWP_UINT32) {
            addresses[0] = remote->value.uint32;
        }
        if (local->value.type == FWP_UINT32) {
            addresses[1] = local->value.uint32;
        }
        for (UINT32 index = 0; index < 2; index++) {
            UINT32 address = addresses[index];
            if ((address & 0xFF000000) == 0x7F000000 ||
                (address & 0x000000FF) == 0x0000007F) {
                return TRUE;
            }
        }
        return FALSE;
    }
    if (RtlEqualMemory(&inFixedValues->layerId, &FWPM_LAYER_ALE_AUTH_CONNECT_V6,
                       sizeof(GUID))) {
        const FWPS_INCOMING_VALUE0 *value =
            &inFixedValues->incomingValue[FWPS_FIELD_ALE_AUTH_CONNECT_V6_IP_REMOTE_ADDRESS];
        if (value->value.type == FWP_BYTE_ARRAY16_TYPE) {
            const UCHAR *bytes = value->value.byteArray16->byteArray16;
            static const UCHAR loopback[16] =
                {0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1};
            if (RtlEqualMemory(bytes, loopback, sizeof(loopback))) {
                return TRUE;
            }
            /* ::ffff:127.0.0.0/8 */
            if (RtlEqualMemory(bytes, "\0\0\0\0\0\0\0\0\0\0\xff\xff\x7f", 13)) {
                return TRUE;
            }
        }
        return FALSE;
    }
    return FALSE;
}

static VOID NTAPI
AihngClassifyConnect(
    _In_ const FWPS_INCOMING_VALUES0 *inFixedValues,
    _In_ const FWPS_INCOMING_METADATA_VALUES0 *inMetaValues,
    _Inout_opt_ void *layerData,
    _In_ const FWPS_FILTER0 *filter,
    _In_ UINT64 flowContext,
    _Inout_ FWPS_CLASSIFY_OUT0 *classifyOut)
{
    UNREFERENCED_PARAMETER(inFixedValues);
    UNREFERENCED_PARAMETER(layerData);
    UNREFERENCED_PARAMETER(filter);
    UNREFERENCED_PARAMETER(flowContext);

    if ((classifyOut->rights & FWPS_RIGHT_ACTION_WRITE) == 0) {
        return;
    }
    if ((inMetaValues->currentMetadataValues & FWPS_METADATA_FIELD_PROCESS_ID) != 0 &&
        AihngIsProtected((UINT32)inMetaValues->processId)) {
        /* Loopback is the only allowed exit: the instance's own proxy
         * listener (and AIH's local gateway/OAuth callbacks) live there.
         * External destinations never are. */
        if (AihngIsLoopbackRemote(inFixedValues)) {
            classifyOut->actionType = FWP_ACTION_PERMIT;
            return;
        }
        classifyOut->actionType = FWP_ACTION_BLOCK;
        classifyOut->rights &= ~FWPS_RIGHT_ACTION_WRITE;
        InterlockedIncrement(&g_Blocked);
        return;
    }
    classifyOut->actionType = FWP_ACTION_PERMIT;
}

static NTSTATUS NTAPI
AihngNotify(
    _In_ FWPS_CALLOUT_NOTIFY_TYPE notifyType,
    _In_ const GUID *filterKey,
    _Inout_ FWPS_FILTER0 *filter)
{
    UNREFERENCED_PARAMETER(notifyType);
    UNREFERENCED_PARAMETER(filterKey);
    UNREFERENCED_PARAMETER(filter);
    return STATUS_SUCCESS;
}

static NTSTATUS
AihngRegisterWfp(_In_ PDEVICE_OBJECT DeviceObject)
{
    FWPM_SESSION0 session;
    FWPM_PROVIDER0 provider;
    FWPM_SUBLAYER0 sublayer;
    FWPS_CALLOUT0 calloutV4;
    FWPS_CALLOUT0 calloutV6;
    FWPM_CALLOUT0 calloutEntry;
    FWPM_FILTER0 filter;
    NTSTATUS status;

    RtlZeroMemory(&session, sizeof(session));
    session.flags = FWPM_SESSION_FLAG_DYNAMIC;
    status = FwpmEngineOpen0(NULL, RPC_C_AUTHN_WINNT, NULL, &session, &g_EngineHandle);
    if (!NT_SUCCESS(status)) {
        return status;
    }

    RtlZeroMemory(&provider, sizeof(provider));
    provider.providerKey = AIHNG_PROVIDER_KEY;
    provider.displayData.name = L"AIH NetGuard";
    provider.displayData.description = L"AIH per-instance network guard";
    status = FwpmProviderAdd0(g_EngineHandle, &provider, NULL);
    if (!NT_SUCCESS(status) && status != STATUS_FWP_ALREADY_EXISTS) {
        return status;
    }

    RtlZeroMemory(&sublayer, sizeof(sublayer));
    sublayer.subLayerKey = AIHNG_SUBLAYER_KEY;
    sublayer.displayData.name = L"AIH NetGuard Sublayer";
    sublayer.weight = 0x100;
    status = FwpmSubLayerAdd0(g_EngineHandle, &sublayer, NULL);
    if (!NT_SUCCESS(status) && status != STATUS_FWP_ALREADY_EXISTS) {
        return status;
    }

    RtlZeroMemory(&calloutV4, sizeof(calloutV4));
    calloutV4.calloutKey = AIHNG_CALLOUT_V4_KEY;
    calloutV4.classifyFn = AihngClassifyConnect;
    calloutV4.notifyFn = AihngNotify;
    status = FwpsCalloutRegister0(DeviceObject, &calloutV4, &g_CalloutIdV4);
    if (!NT_SUCCESS(status)) {
        return status;
    }
    RtlZeroMemory(&calloutV6, sizeof(calloutV6));
    calloutV6.calloutKey = AIHNG_CALLOUT_V6_KEY;
    calloutV6.classifyFn = AihngClassifyConnect;
    calloutV6.notifyFn = AihngNotify;
    status = FwpsCalloutRegister0(DeviceObject, &calloutV6, &g_CalloutIdV6);
    if (!NT_SUCCESS(status)) {
        return status;
    }

    RtlZeroMemory(&calloutEntry, sizeof(calloutEntry));
    calloutEntry.calloutKey = AIHNG_CALLOUT_V4_KEY;
    calloutEntry.displayData.name = L"AIH NetGuard Connect V4";
    calloutEntry.providerKey = (GUID *)&AIHNG_PROVIDER_KEY;
    calloutEntry.applicableLayer = FWPM_LAYER_ALE_AUTH_CONNECT_V4;
    status = FwpmCalloutAdd0(g_EngineHandle, &calloutEntry, NULL, NULL);
    if (!NT_SUCCESS(status) && status != STATUS_FWP_ALREADY_EXISTS) {
        return status;
    }
    calloutEntry.calloutKey = AIHNG_CALLOUT_V6_KEY;
    calloutEntry.displayData.name = L"AIH NetGuard Connect V6";
    calloutEntry.applicableLayer = FWPM_LAYER_ALE_AUTH_CONNECT_V6;
    status = FwpmCalloutAdd0(g_EngineHandle, &calloutEntry, NULL, NULL);
    if (!NT_SUCCESS(status) && status != STATUS_FWP_ALREADY_EXISTS) {
        return status;
    }

    RtlZeroMemory(&filter, sizeof(filter));
    filter.layerKey = FWPM_LAYER_ALE_AUTH_CONNECT_V4;
    filter.displayData.name = L"AIH NetGuard Filter V4";
    filter.action.type = FWP_ACTION_CALLOUT_TERMINATING;
    filter.action.calloutKey = AIHNG_CALLOUT_V4_KEY;
    filter.subLayerKey = AIHNG_SUBLAYER_KEY;
    filter.weight.type = FWP_EMPTY;
    filter.providerKey = (GUID *)&AIHNG_PROVIDER_KEY;
    status = FwpmFilterAdd0(g_EngineHandle, &filter, NULL, &g_FilterIdV4);
    if (!NT_SUCCESS(status)) {
        return status;
    }
    filter.layerKey = FWPM_LAYER_ALE_AUTH_CONNECT_V6;
    filter.displayData.name = L"AIH NetGuard Filter V6";
    filter.action.calloutKey = AIHNG_CALLOUT_V6_KEY;
    status = FwpmFilterAdd0(g_EngineHandle, &filter, NULL, &g_FilterIdV6);
    return status;
}

static VOID
AihngUnregisterWfp(void)
{
    if (g_EngineHandle != NULL) {
        if (g_FilterIdV4 != 0) {
            FwpmFilterDeleteById0(g_EngineHandle, g_FilterIdV4);
        }
        if (g_FilterIdV6 != 0) {
            FwpmFilterDeleteById0(g_EngineHandle, g_FilterIdV6);
        }
        FwpmEngineClose0(g_EngineHandle);
        g_EngineHandle = NULL;
    }
    if (g_CalloutIdV4 != 0) {
        FwpsCalloutUnregisterById0(g_CalloutIdV4);
        g_CalloutIdV4 = 0;
    }
    if (g_CalloutIdV6 != 0) {
        FwpsCalloutUnregisterById0(g_CalloutIdV6);
        g_CalloutIdV6 = 0;
    }
}

static NTSTATUS
AihngDeviceControl(_In_ PDEVICE_OBJECT DeviceObject, _Inout_ PIRP Irp)
{
    PIO_STACK_LOCATION stack;
    NTSTATUS status = STATUS_SUCCESS;
    ULONG information = 0;
    ULONG inputLength;
    ULONG outputLength;
    ULONG code;

    UNREFERENCED_PARAMETER(DeviceObject);
    stack = IoGetCurrentIrpStackLocation(Irp);
    inputLength = stack->Parameters.DeviceIoControl.InputBufferLength;
    outputLength = stack->Parameters.DeviceIoControl.OutputBufferLength;
    code = stack->Parameters.DeviceIoControl.IoControlCode;

    switch (code) {
    case AIHNG_IOCTL_SET_PIDS:
        if (inputLength < sizeof(ULONG)) {
            status = STATUS_BUFFER_TOO_SMALL;
            break;
        }
        {
            ULONG count = *(ULONG *)Irp->AssociatedIrp.SystemBuffer;
            ULONG available = (inputLength - sizeof(ULONG)) / sizeof(ULONG);
            KIRQL irql;
            if (count > available) {
                status = STATUS_INVALID_BUFFER_SIZE;
                break;
            }
            if (count > AIHNG_MAX_PIDS) {
                count = AIHNG_MAX_PIDS;
            }
            KeAcquireSpinLock(&g_PidLock, &irql);
            g_PidCount = count;
            if (count > 0) {
                RtlCopyMemory(g_Pids, (ULONG *)Irp->AssociatedIrp.SystemBuffer + 1,
                              count * sizeof(ULONG));
            }
            KeReleaseSpinLock(&g_PidLock, irql);
            information = sizeof(ULONG);
        }
        break;
    case AIHNG_IOCTL_GET_STATUS:
        if (outputLength < sizeof(AIHNG_STATUS)) {
            status = STATUS_BUFFER_TOO_SMALL;
            break;
        }
        {
            AIHNG_STATUS *result = (AIHNG_STATUS *)Irp->AssociatedIrp.SystemBuffer;
            KIRQL irql;
            KeAcquireSpinLock(&g_PidLock, &irql);
            result->Count = g_PidCount;
            KeReleaseSpinLock(&g_PidLock, irql);
            result->Blocked = (ULONG)InterlockedCompareExchange(&g_Blocked, 0, 0);
            information = sizeof(AIHNG_STATUS);
        }
        break;
    default:
        status = STATUS_INVALID_DEVICE_REQUEST;
        break;
    }

    Irp->IoStatus.Status = status;
    Irp->IoStatus.Information = information;
    IoCompleteRequest(Irp, IO_NO_INCREMENT);
    return status;
}

static NTSTATUS
AihngCreateClose(_In_ PDEVICE_OBJECT DeviceObject, _Inout_ PIRP Irp)
{
    UNREFERENCED_PARAMETER(DeviceObject);
    Irp->IoStatus.Status = STATUS_SUCCESS;
    Irp->IoStatus.Information = 0;
    IoCompleteRequest(Irp, IO_NO_INCREMENT);
    return STATUS_SUCCESS;
}

static VOID
AihngUnload(_In_ PDRIVER_OBJECT DriverObject)
{
    UNICODE_STRING symlink;
    UNREFERENCED_PARAMETER(DriverObject);
    AihngUnregisterWfp();
    RtlInitUnicodeString(&symlink, AIHNG_SYMLINK_NAME);
    IoDeleteSymbolicLink(&symlink);
    if (g_DeviceObject != NULL) {
        IoDeleteDevice(g_DeviceObject);
        g_DeviceObject = NULL;
    }
}

NTSTATUS
DriverEntry(_In_ PDRIVER_OBJECT DriverObject, _In_ PUNICODE_STRING RegistryPath)
{
    UNICODE_STRING deviceName;
    UNICODE_STRING symlink;
    NTSTATUS status;

    UNREFERENCED_PARAMETER(RegistryPath);
    KeInitializeSpinLock(&g_PidLock);

    RtlInitUnicodeString(&deviceName, AIHNG_DEVICE_NAME);
    status = IoCreateDevice(DriverObject, 0, &deviceName, FILE_DEVICE_UNKNOWN,
                            FILE_DEVICE_SECURE_OPEN, FALSE, &g_DeviceObject);
    if (!NT_SUCCESS(status)) {
        return status;
    }
    RtlInitUnicodeString(&symlink, AIHNG_SYMLINK_NAME);
    status = IoCreateSymbolicLink(&symlink, &deviceName);
    if (!NT_SUCCESS(status)) {
        IoDeleteDevice(g_DeviceObject);
        g_DeviceObject = NULL;
        return status;
    }

    DriverObject->MajorFunction[IRP_MJ_CREATE] = AihngCreateClose;
    DriverObject->MajorFunction[IRP_MJ_CLOSE] = AihngCreateClose;
    DriverObject->MajorFunction[IRP_MJ_DEVICE_CONTROL] = AihngDeviceControl;
    DriverObject->DriverUnload = AihngUnload;

    status = AihngRegisterWfp(g_DeviceObject);
    if (!NT_SUCCESS(status)) {
        AihngUnload(DriverObject);
        return status;
    }
    return STATUS_SUCCESS;
}
