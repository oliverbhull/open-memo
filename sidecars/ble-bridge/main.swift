import CoreBluetooth
import Foundation

private let serviceID = CBUUID(string: "7E400001-B5A3-F393-E0A9-E50E24DCCA9E")
private let rxID = CBUUID(string: "7E400002-B5A3-F393-E0A9-E50E24DCCA9E")
private let txID = CBUUID(string: "7E400003-B5A3-F393-E0A9-E50E24DCCA9E")
private let excludedPeripheralIDs: Set<UUID> = {
    var values = Set<UUID>()
    var arguments = CommandLine.arguments.dropFirst().makeIterator()
    while let argument = arguments.next() {
        guard argument == "--exclude", let value = arguments.next(), let identifier = UUID(uuidString: value) else {
            diagnostic("invalid BLE bridge arguments")
            exit(6)
        }
        values.insert(identifier)
    }
    return values
}()

private func diagnostic(_ message: String) {
    FileHandle.standardError.write(Data((message + "\n").utf8))
}

final class Bridge: NSObject, CBCentralManagerDelegate, CBPeripheralDelegate {
    private var manager: CBCentralManager!
    private var peripheral: CBPeripheral?
    private var rx: CBCharacteristic?
    private var writeQueue: [Data] = []
    private var writeActive = false
    private var commandBuffer = Data()
    private var discoveryTimer: Timer?

    override init() {
        super.init()
        manager = CBCentralManager(delegate: self, queue: nil)
    }

    private func startDiscoveryTimer() {
        discoveryTimer?.invalidate()
        discoveryTimer = Timer.scheduledTimer(withTimeInterval: 8, repeats: false) { _ in
            diagnostic("no Memo recorder found")
            exit(3)
        }
    }

    func centralManagerDidUpdateState(_ central: CBCentralManager) {
        guard central.state == .poweredOn else {
            if central.state != .unknown && central.state != .resetting {
                diagnostic("Bluetooth unavailable: \(central.state.rawValue)")
                exit(2)
            }
            return
        }
        startDiscoveryTimer()
        central.scanForPeripherals(withServices: [serviceID], options: [CBCentralManagerScanOptionAllowDuplicatesKey: false])
    }

    func centralManager(_ central: CBCentralManager, didDiscover peripheral: CBPeripheral,
                        advertisementData: [String: Any], rssi RSSI: NSNumber) {
        guard self.peripheral == nil, !excludedPeripheralIDs.contains(peripheral.identifier) else { return }
        self.peripheral = peripheral
        discoveryTimer?.invalidate()
        central.stopScan()
        peripheral.delegate = self
        central.connect(peripheral)
    }

    func centralManager(_ central: CBCentralManager, didConnect peripheral: CBPeripheral) {
        diagnostic("connected \(peripheral.identifier.uuidString)")
        peripheral.discoverServices([serviceID])
    }

    func centralManager(_ central: CBCentralManager, didFailToConnect peripheral: CBPeripheral, error: Error?) {
        diagnostic("connection failed: \(error?.localizedDescription ?? "unknown error")")
        exit(4)
    }

    func centralManager(_ central: CBCentralManager, didDisconnectPeripheral peripheral: CBPeripheral,
                        timestamp: CFAbsoluteTime, isReconnecting: Bool, error: Error?) {
        diagnostic("disconnected: \(error?.localizedDescription ?? "remote closed")")
        exit(error == nil ? 0 : 5)
    }

    func peripheral(_ peripheral: CBPeripheral, didDiscoverServices error: Error?) {
        guard error == nil, let service = peripheral.services?.first(where: { $0.uuid == serviceID }) else {
            diagnostic("Memo service discovery failed")
            exit(4)
        }
        peripheral.discoverCharacteristics([rxID, txID], for: service)
    }

    func peripheral(_ peripheral: CBPeripheral, didDiscoverCharacteristicsFor service: CBService, error: Error?) {
        guard error == nil else {
            diagnostic("Memo characteristic discovery failed")
            exit(4)
        }
        rx = service.characteristics?.first(where: { $0.uuid == rxID })
        guard let tx = service.characteristics?.first(where: { $0.uuid == txID }), rx != nil else {
            diagnostic("Memo stream characteristics are missing")
            exit(4)
        }
        peripheral.setNotifyValue(true, for: tx)
    }

    func peripheral(_ peripheral: CBPeripheral, didUpdateNotificationStateFor characteristic: CBCharacteristic,
                    error: Error?) {
        guard error == nil, characteristic.isNotifying else {
            diagnostic("Memo notification subscription failed")
            exit(4)
        }
        FileHandle.standardOutput.write(Data("BRIDGE \(peripheral.identifier.uuidString)\n".utf8))
        FileHandle.standardInput.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            guard !data.isEmpty else { exit(0) }
            DispatchQueue.main.async { self?.acceptInput(data) }
        }
    }

    private func acceptInput(_ data: Data) {
        commandBuffer.append(data)
        while let newline = commandBuffer.firstIndex(of: 0x0a) {
            let end = commandBuffer.index(after: newline)
            let command = Data(commandBuffer[..<end])
            commandBuffer.removeSubrange(..<end)
            enqueue(command)
        }
        if commandBuffer.count > 63 {
            diagnostic("refusing unterminated command larger than 63 bytes")
            exit(6)
        }
    }

    private func enqueue(_ data: Data) {
        guard data.count <= 63 else {
            diagnostic("refusing command larger than 63 bytes")
            exit(6)
        }
        writeQueue.append(data)
        writeNext()
    }

    private func writeNext() {
        guard !writeActive, let peripheral, let rx, !writeQueue.isEmpty else { return }
        writeActive = true
        peripheral.writeValue(writeQueue.removeFirst(), for: rx, type: .withResponse)
    }

    func peripheral(_ peripheral: CBPeripheral, didWriteValueFor characteristic: CBCharacteristic, error: Error?) {
        guard error == nil else {
            diagnostic("Memo command write failed: \(error!.localizedDescription)")
            exit(5)
        }
        writeActive = false
        writeNext()
    }

    func peripheral(_ peripheral: CBPeripheral, didUpdateValueFor characteristic: CBCharacteristic, error: Error?) {
        guard error == nil, let value = characteristic.value else {
            diagnostic("Memo notification failed")
            exit(5)
        }
        FileHandle.standardOutput.write(value)
    }
}

let bridge = Bridge()
withExtendedLifetime(bridge) {
    RunLoop.main.run()
}
