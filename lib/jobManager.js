var events = require('events');
var crypto = require('crypto');

var bignum = require('bignum');



var util = require('./util.js');
var blockTemplate = require('./blockTemplate.js');


//Unique extranonce per subscriber
var ExtraNonceCounter = function (configInstanceId) {

    var instanceId = configInstanceId || crypto.randomBytes(4).readUInt32LE(0);
    var counter = instanceId << 27;

    this.next = function () {
        var extraNonce = util.packUInt32BE(Math.abs(counter++));
        return extraNonce.toString('hex');
    };

    this.size = 4; //bytes
};

//Unique job per new block template
var JobCounter = function () {
    var counter = 0;

    this.next = function () {
        counter++;
        if (counter % 0xffff === 0)
            counter = 1;
        return this.cur();
    };

    this.cur = function () {
        return counter.toString(16);
    };
};

/**
 * Emits:
 * - newBlock(blockTemplate) - When a new block (previously unknown to the JobManager) is added, use this event to broadcast new jobs
 * - share(shareData, blockHex) - When a worker submits a share. It will have blockHex if a block was found
**/
var JobManager = module.exports = function JobManager(options) {


    //private members

    var _this = this;
    var jobCounter = new JobCounter();

    //var shareMultiplier = algo[options.coin.algorithm].multiplier;
    //const { diff1 } = algo[options.coin.algorithm];

    //public members

    this.extraNonceCounter = new ExtraNonceCounter(options.instanceId);
    this.extraNoncePlaceholder = Buffer.from('f000000ff111111f', 'hex');
    this.extraNonce2Size = this.extraNoncePlaceholder.length - this.extraNonceCounter.size;

    this.currentJob;
    this.validJobs = {};

    var hashDigest = algos[options.coin.algorithm].hash(options.coin);

    // Determine Block Hash Function
    function blockHash() {
        switch (options.coin.algorithm) {
            default:
                return function (d) {
                    return util.reverseBuffer(util.sha256d(d));
                };
        }
    }

    // Determine Coinbase Hash Function
    function coinbaseHash() {
        switch (options.coin.algorithm) {
            default:
                return util.sha256d;
        }
    }

    // Establish Main Hash Functions
    const blockHasher = blockHash();
    const coinbaseHasher = coinbaseHash();

    this.updateCurrentJob = function (rpcData) {

        var tmpBlockTemplate = new blockTemplate(
            jobCounter.next(),
            rpcData,
            options.poolAddressScript,
            _this.extraNoncePlaceholder,
            options.coin.reward,
            options.coin.txMessages,
            options.recipients
        );

        _this.currentJob = tmpBlockTemplate;

        _this.emit('updatedBlock', tmpBlockTemplate, true);

        _this.validJobs[tmpBlockTemplate.jobId] = tmpBlockTemplate;

    };

    //returns true if processed a new block
    this.processTemplate = function (rpcData) {

        //console.info(JSON.stringify(rpcData));
        /* Block is new if A) its the first block we have seen so far or B) the blockhash is different and the
           block height is greater than the one we have */
        var isNewBlock = typeof (_this.currentJob) === 'undefined';
        if (!isNewBlock && _this.currentJob.rpcData.previousblockhash !== rpcData.previousblockhash) {
            isNewBlock = true;

            //If new block is outdated/out-of-sync than return
            if (rpcData.height < _this.currentJob.rpcData.height)
                return false;
        }

        if (!isNewBlock) return false;


        var tmpBlockTemplate = new blockTemplate(
            jobCounter.next(),
            rpcData,
            options.poolAddressScript,
            _this.extraNoncePlaceholder,
            options.coin.reward,
            options.coin.txMessages,
            options.recipients
        );

        this.currentJob = tmpBlockTemplate;

        this.validJobs = {};
        _this.emit('newBlock', tmpBlockTemplate);

        this.validJobs[tmpBlockTemplate.jobId] = tmpBlockTemplate;

        return true;

    };

    this.processShare = function (jobId, previousPoolDifficulty, poolDifficulty, extraNonce1, extraNonce2, nTime, nonce, ipAddress, port, workerName, versionMask) {
       
       console.info('version_mask: ' + versionMask)
        var shareError = function (error) {
            _this.emit('share', {
                job: jobId,
                ip: ipAddress,
                worker: workerName,
                difficulty: poolDifficulty,
                error: error[1]
            });
            return { error: error, result: null };
        };

        var submitTime = Math.trunc(Date.now() / 1000);

        if (extraNonce2.length / 2 !== _this.extraNonce2Size)
            return shareError([20, 'incorrect size of extranonce2']);

        var job = this.validJobs[jobId];

        if (typeof job === 'undefined' || job.jobId != jobId) {
            return shareError([21, 'job not found']);
        }

        if (nTime.length !== 8) {
            return shareError([20, 'incorrect size of ntime']);
        }

        var nTimeInt = parseInt(nTime, 16);
        if (nTimeInt < job.rpcData.curtime || nTimeInt > submitTime + 7200) {
            return shareError([20, 'ntime out of range']);
        }

        if (nonce.length !== 8) {
            return shareError([20, 'incorrect size of nonce']);
        }

        if (!job.registerSubmit(extraNonce1, extraNonce2, nTime, nonce, versionMask)) {
            return shareError([22, 'duplicate share']);
        }


        var extraNonce1Buffer = Buffer.from(extraNonce1, 'hex');
        var extraNonce2Buffer = Buffer.from(extraNonce2, 'hex');

        var coinbaseBuffer = job.serializeCoinbase(extraNonce1Buffer, extraNonce2Buffer);
        var coinbaseHash = coinbaseHasher(coinbaseBuffer);

        var merkleRoot = util.reverseBuffer(job.merkleTree.withFirst(coinbaseHash)).toString('hex');

        let [headerBuffer, finishSolution] = job.startSolution(
            coinbaseBuffer, merkleRoot, nTime, nonce, versionMask
        );

        
        var headerHash = hashDigest(headerBuffer, nTimeInt);
        var headerBigNum = bignum.fromBuffer(headerHash, { endian: 'little', size: 32 });

        var blockHeaderHash;
        var blockHashInvalid;

        //решение
        let blockHex;

        let difficulty = poolDifficulty;

        let shareDiff = (0x00000000ffff0000000000000000000000000000000000000000000000000000 / headerBigNum.toNumber()) * 1; //shareMultiplier

        var blockDiffAdjusted = job.difficulty * 1;//shareMultiplier;

        console.info(shareDiff +'\n'+ headerBigNum + '\n' + job.target + '\n' + job.target.ge(headerBigNum))
        //Check if share is a block candidate (matched network difficulty)
        if (job.target.ge(headerBigNum)) {
            blockSolution = finishSolution();
            blockHex = job.serializeBlock(headerBuffer,coinbaseBuffer).toString('hex');
            blockHeaderHash = blockHasher(headerBuffer, nTime).toString('hex');
        }
        else {
            // blockHeaderHash = blockHasher(headerBuffer, nTime).toString('hex');
            // console.info('Hash:' + blockHeaderHash);
            // if (options.emitInvalidBlockHashes)
            //     blockHashInvalid = util.reverseBuffer(util.sha256d(headerBuffer)).toString('hex');

            // //Check if share didn't reached the miner's difficulty)
            // if (shareDiff / poolDifficulty < 0.99) {

            //     //Check if share matched a previous difficulty from before a vardiff retarget
            //     if (previousPoolDifficulty && shareDiff >= previousPoolDifficulty) {
            //         difficulty = previousPoolDifficulty;
            //     }
            //     else {
            //         return shareError([23, 'low difficulty share of ' + shareDiff + 'and pool diff' + poolDifficulty + and ]);
            //     }

            // }
        }
        
        _this.emit('share', {
            job: jobId,
            ip: ipAddress,
            port: port,
            worker: workerName,
            height: job.rpcData.height,
            blockReward: job.rpcData.coinbasevalue,
            difficulty: difficulty,
            shareDiff: shareDiff.toFixed(8),
            blockDiff: blockDiffAdjusted,
            blockDiffActual: job.difficulty,
            blockHash: blockHeaderHash,
            blockHashInvalid: blockHashInvalid,
            versionMask: versionMask
        }, blockHex);

        return { result: true, error: null, blockHash: blockHeaderHash };
    };
};
JobManager.prototype.__proto__ = events.EventEmitter.prototype;
